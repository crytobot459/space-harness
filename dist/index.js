import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/index.ts
import { mkdirSync as mkdirSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/rules.js
function segments(command) {
  return command.split(/(?:&&|\|\||[;\n|])\s*/g).map((s) => s.trim()).filter(Boolean);
}
var BASH_RULES = [
  {
    name: "secret exfiltration via shell",
    scope: "command",
    test: /\b(TOKEN|SECRET|KEY|PASSWORD|API_KEY)\s*=\s*\$\(\s*(curl|wget)\b/i,
    why: "assigns a fetched value into a credential-named variable"
  },
  {
    name: "remote delete over ssh",
    scope: "command",
    test: /\bssh\b[^|;&]*\brm\s+-[a-zA-Z]*[rf]/i,
    why: "destructive command executed on another host"
  },
  {
    name: "pipe remote script into a shell",
    scope: "command",
    test: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python[0-9.]*)\b/i,
    why: "downloads and executes a script in one step"
  },
  {
    name: "git push with force",
    scope: "segment",
    test: /^git\s+push\b(?!.*--(dry-run|-n)\b).*(--force|-f)\b/i,
    why: "overwrites published history"
  },
  {
    name: "git push",
    scope: "segment",
    test: /^git\s+push\b(?!.*--dry-run\b)(?!.*(^|\s)-n(\s|$))/i,
    why: "publishing is a human decision"
  },
  {
    name: "recursive delete",
    scope: "segment",
    test: /^rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*)\s+/i,
    why: "rm with a recursive or force flag"
  },
  {
    name: "chmod 777",
    scope: "segment",
    test: /^chmod\s+(-[a-zA-Z]+\s+)*777\b/,
    why: "opens permissions on everything"
  },
  {
    name: "history rewrite",
    scope: "segment",
    test: /^git\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|rebase\s+.*--force)/i,
    why: "destroys work that only exists locally"
  }
];
var WRITE_RULES = [
  {
    name: "write to a dotenv file",
    test: /(^|[\\/])\.env(\.|$)/i,
    unless: /(^|[\\/])\.env\.(example|sample|template|defaults?)\b/i,
    why: "dotenv files hold live credentials"
  },
  {
    name: "write to a credentials file",
    test: /(^|[\\/])\.(npmrc|pypirc|netrc|git-credentials)(\.|$)/i,
    unless: /(^|[\\/])\.(npmrc|pypirc)\.example$/i,
    why: "registry and git credentials"
  },
  {
    name: "write to a private key",
    test: /(^|[\\/])id_(rsa|ed25519|ecdsa|dsa)\b/i,
    why: "private key material"
  }
];
function checkBash(command, rules = BASH_RULES) {
  if (!command || !command.trim())
    return null;
  const parts = segments(command);
  for (const rule of rules) {
    if (rule.scope === "command") {
      if (rule.test.test(command))
        return { name: rule.name, why: rule.why, segment: command };
      continue;
    }
    for (const seg of parts) {
      if (rule.test.test(seg))
        return { name: rule.name, why: rule.why, segment: seg };
    }
  }
  return null;
}
function checkWrite(target, rules = WRITE_RULES) {
  if (!target)
    return null;
  for (const rule of rules) {
    if (!rule.test.test(target))
      continue;
    if (rule.unless?.test(target))
      continue;
    return { name: rule.name, why: rule.why, segment: target };
  }
  return null;
}

// src/guard.ts
var MARKER = "[opencode-harness-kit] blocked";
function deny(why, detail) {
  throw new Error(`${MARKER}: ${why}
  ${detail}
` + `  This is enforced in code, not by a prompt. If the command is genuinely ` + `safe, run it yourself in a terminal.`);
}
function truncate(s, n = 200) {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}...` : one;
}
var GuardPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (input.tool === "bash") {
          const hit = checkBash(String(output.args?.command ?? ""));
          if (hit)
            deny(hit.name, `${hit.why}
  command: ${truncate(hit.segment)}`);
          return;
        }
        if (input.tool === "write" || input.tool === "edit" || input.tool === "patch") {
          const target = String(output.args?.filePath ?? output.args?.path ?? "") || String(output.args?.changes?.[0]?.filePath ?? "");
          const hit = checkWrite(target);
          if (hit)
            deny(hit.name, `${hit.why}
  file: ${truncate(hit.segment)}`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith(MARKER))
          throw err;
        throw new Error(`${MARKER} (guard failed closed): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
};

// src/profile.js
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var HERE = dirname(fileURLToPath(import.meta.url));
var ROOT = resolve(HERE, "..");

class ProfileError extends Error {
}
function profileDirs() {
  return [join(ROOT, "profiles"), join(ROOT, "examples")];
}
function profilePath(id) {
  for (const dir of profileDirs()) {
    const full = join(dir, `${id}.json`);
    if (existsSync(full))
      return full;
  }
  return null;
}
function loadProfile(id) {
  const path = profilePath(id);
  if (!path) {
    throw new ProfileError(`no profile named "${id}". Run: oc-harness list`);
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ProfileError(`cannot read ${path}: ${msg}`);
  }
  validate(raw, path);
  return normalize(raw);
}
function normalize(p) {
  return {
    ...p,
    limits: { ...p.limits, input: p.limits.input ?? p.limits.context },
    effort: {
      levels: p.effort?.levels ?? [],
      default: p.effort?.default ?? null,
      reserveShare: p.effort?.reserveShare ?? 0.12
    },
    prune: {
      enabled: p.prune?.enabled ?? false,
      keepRecentToolCalls: p.prune?.keepRecentToolCalls ?? 6,
      keepRecentTurns: p.prune?.keepRecentTurns ?? 3,
      keepUserMessages: p.prune?.keepUserMessages ?? true
    },
    fallback: p.fallback ?? []
  };
}
var VALID_RETENTION = ["zero-retention", "may-train", "unknown"];
function validate(p, path = "<memory>") {
  const where = p?.id ?? path;
  if (!p?.id)
    throw new ProfileError(`${path}: missing "id"`);
  if (!p.provider)
    throw new ProfileError(`${where}: missing "provider"`);
  if (!p.model)
    throw new ProfileError(`${where}: missing "model"`);
  if (!VALID_RETENTION.includes(p.retention)) {
    throw new ProfileError(`${where}: retention must be one of ${VALID_RETENTION.join(", ")}`);
  }
  if (!p.limits?.context || p.limits.context <= 0) {
    throw new ProfileError(`${where}: limits.context must be a positive integer`);
  }
  if (!p.limits?.output || p.limits.output <= 0) {
    throw new ProfileError(`${where}: limits.output must be a positive integer`);
  }
  const share = p.effort?.reserveShare;
  if (share !== undefined && (share < 0 || share > 0.5)) {
    throw new ProfileError(`${where}: effort.reserveShare must be between 0 and 0.5`);
  }
}
var CANON = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
function resolveEffort(levels, requested) {
  if (!requested)
    return null;
  if (!levels || levels.length === 0)
    return null;
  if (levels.includes(requested))
    return requested;
  const want = CANON.indexOf(requested);
  if (want < 0) {
    return levels[levels.length - 1] ?? null;
  }
  let best = null;
  let bestDist = Infinity;
  for (const level of levels) {
    const have = CANON.indexOf(level);
    if (have < 0)
      continue;
    const d = Math.abs(have - want);
    if (d < bestDist) {
      bestDist = d;
      best = level;
    }
  }
  return best ?? levels[levels.length - 1] ?? null;
}
function resolveRoles(p) {
  const levels = p.effort?.levels ?? [];
  const out = {};
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    out[role] = resolveEffort(levels, want);
  }
  return out;
}
function resolveDefaultVariant(p) {
  return resolveEffort(p.effort?.levels ?? [], p.effort?.default ?? null);
}
function reservedTokens(p) {
  const input = p.limits.input ?? p.limits.context;
  const share = p.effort?.reserveShare ?? 0.12;
  return Math.max(8000, Math.round(input * share));
}
function pruneThreshold(p) {
  return (p.limits.input ?? p.limits.context) - reservedTokens(p);
}
function configFilePath() {
  const dir = process.env.OPENCODE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".config", "opencode");
  return join(dir, "opencode.jsonc");
}
function profileIdFromConfig() {
  const fromEnv = process.env.OPENCODE_HARNESS_PROFILE;
  if (fromEnv)
    return fromEnv.trim() || null;
  const file = configFilePath();
  if (!existsSync(file))
    return null;
  try {
    const text = readFileSync(file, "utf8");
    const json = text.slice(text.indexOf("{"));
    const parsed = JSON.parse(json);
    const id = parsed?.harness?.profile;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

// src/prune.ts
import { readFileSync as readFileSync2, existsSync as existsSync2 } from "node:fs";
import { join as join2 } from "node:path";
function activeProfileId(worktree) {
  const candidates = [
    process.env.OPENCODE_HARNESS_PROFILE,
    join2(worktree, ".space", "active"),
    join2(ROOT, "profiles", ".active")
  ];
  for (const f of candidates) {
    if (!f)
      continue;
    try {
      if (existsSync2(f)) {
        const v = readFileSync2(f, "utf8").trim();
        if (v)
          return v;
      }
    } catch {}
  }
  return null;
}
function sizeOf(part) {
  if (typeof part?.text === "string")
    return part.text.length;
  if (typeof part?.state?.output === "string")
    return part.state.output.length;
  return 0;
}
function stub(part) {
  const tool = part?.tool ?? "tool";
  const state = part?.state ?? {};
  const input = state.input ?? {};
  if (tool === "bash") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").slice(0, 80);
    const status = state.status ?? "done";
    let tail = "";
    const out = String(state.output ?? "");
    const m = out.match(/(passed|failed|error|Error|ok|OK|\d+ (?:passed|failed))/g);
    if (m && m.length)
      tail = `, ${m[m.length - 1]}`;
    return `[${tool}] ${cmd} -> ${status}${tail} | full output was pruned from context; re-run the command if you need it`;
  }
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list") {
    const target = String(input.filePath ?? input.path ?? input.pattern ?? "");
    return `[${tool}] ${target.slice(0, 100)} | result pruned from context; re-read it if you need it`;
  }
  return `[${tool}] result pruned from context (${state.status ?? "done"}); re-run if you need it`;
}
var PrunePlugin = async ({ worktree, $ }) => {
  let profile = null;
  try {
    const id = activeProfileId(worktree);
    if (id)
      profile = loadProfile(id);
  } catch {
    profile = null;
  }
  if (!profile?.prune?.enabled) {
    return {};
  }
  const keepCalls = profile.prune.keepRecentToolCalls ?? 6;
  const keepTurns = profile.prune.keepRecentTurns ?? 3;
  const keepUsers = profile.prune.keepUserMessages ?? true;
  const threshold = pruneThreshold(profile);
  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const messages = output.messages;
        if (!Array.isArray(messages) || messages.length === 0)
          return;
        const floor = Math.max(0, messages.length - 1 - keepTurns);
        const keepToolMessageIds = new Set;
        let seen = 0;
        for (let i = messages.length - 1;i >= 0 && seen < keepCalls; i--) {
          const msg = messages[i];
          if (!msg?.parts)
            continue;
          for (const part of msg.parts) {
            if (part?.type !== "tool")
              continue;
            if (seen >= keepCalls)
              break;
            keepToolMessageIds.add(msg.info?.id ?? String(i));
            seen++;
          }
        }
        const stats = {
          stubbed: 0,
          kept: 0,
          bytesBefore: 0,
          bytesAfter: 0
        };
        for (let i = 0;i < floor; i++) {
          const msg = messages[i];
          if (!msg?.parts)
            continue;
          const isUser = msg.info?.role === "user";
          for (const part of msg.parts) {
            const size = sizeOf(part);
            stats.bytesBefore += size;
            if (isUser && keepUsers) {
              stats.bytesAfter += size;
              stats.kept++;
              continue;
            }
            if (keepToolMessageIds.has(msg.info?.id ?? String(i))) {
              stats.bytesAfter += size;
              stats.kept++;
              continue;
            }
            switch (part?.type) {
              case "patch":
              case "file":
                stats.bytesAfter += size;
                stats.kept++;
                break;
              case "reasoning":
                stats.bytesAfter += Math.min(size, 200);
                stats.stubbed++;
                break;
              case "tool": {
                const state = part.state;
                if (state?.status !== "completed") {
                  stats.bytesAfter += size;
                  stats.kept++;
                  break;
                }
                part.state = {
                  status: "completed",
                  input: state.input,
                  output: stub(part),
                  title: state.title,
                  time: state.time,
                  metadata: { ...state.metadata ?? {}, pruned: true, prunedAt: new Date().toISOString() }
                };
                stats.bytesAfter += sizeOf(part);
                stats.stubbed++;
                break;
              }
              case "text":
                stats.bytesAfter += size;
                stats.kept++;
                break;
              default:
                stats.bytesAfter += size;
                stats.kept++;
            }
          }
        }
        if (stats.stubbed > 0) {
          const saved = Math.max(0, stats.bytesBefore - stats.bytesAfter);
          await logPrune(profile.id, {
            ...stats,
            saved,
            threshold
          });
        }
      } catch (err) {
        console.error(`[opencode-harness-kit] prune skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
};
async function logPrune(profileId, stats) {
  const dir = join2(process.cwd(), ".space");
  try {
    const { mkdir, appendFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await appendFile(join2(dir, "prune.jsonl"), JSON.stringify({
      t: new Date().toISOString(),
      profile: profileId,
      stubbed: stats.stubbed,
      kept: stats.kept,
      savedBytes: stats.saved,
      threshold: stats.threshold
    }) + `
`);
  } catch {}
}

// src/router.ts
import { readFileSync as readFileSync3, writeFileSync, mkdirSync } from "node:fs";
import { join as join3 } from "node:path";
function healthPath(worktree) {
  return join3(worktree, ".space", "health.json");
}
function readHealth(worktree) {
  try {
    return JSON.parse(readFileSync3(healthPath(worktree), "utf8"));
  } catch {
    return { unhealthy: {} };
  }
}
function writeHealth(worktree, h) {
  try {
    mkdirSync(join3(worktree, ".space"), { recursive: true });
    writeFileSync(healthPath(worktree), JSON.stringify(h, null, 2));
  } catch {}
}
var SPENT = [
  /FreeUsageLimitError/i,
  /rate[_ -]?limit/i,
  /\b429\b/,
  /quota (?:exceeded|exhausted)/i,
  /overloaded_error/i,
  /model .*not found/i,
  /no available provider/i
];
function classify(text) {
  for (const p of SPENT)
    if (p.test(text))
      return p.source;
  return null;
}
var WARN_TEXT = "[opencode-harness-kit] This session's model route is rate limited or withdrawn. " + "No plugin can swap a live session's model, so stop retrying and ask the human to start a " + "new session. Run `oc-harness list` to see the fallback queue, or `oc-harness doctor` to " + "check whether the profile still matches live metadata.";
var RouterPlugin = async ({ worktree }) => {
  let failedSessions = 0;
  let warned = false;
  return {
    config: async (config) => {
      try {
        const cfg = config;
        const health = readHealth(worktree);
        const activeId = cfg.harness?.profile ?? profileIdFromConfig();
        if (activeId) {
          const id = activeId;
          const mark = health.unhealthy[`opencode/${id}`];
          if (mark) {
            let chosen = id;
            try {
              const queue = [id, ...loadProfile(id).fallback ?? []];
              for (const candidate of queue) {
                if (!health.unhealthy[`opencode/${candidate}`]) {
                  chosen = candidate;
                  break;
                }
              }
            } catch {}
            if (chosen !== id) {
              applyProfileToConfig(cfg, chosen);
              health.active = chosen;
              writeHealth(worktree, health);
            }
          }
        }
      } catch {}
    },
    event: async ({ event }) => {
      const e = event;
      const type = e?.type;
      if (!type)
        return;
      const text = JSON.stringify(e);
      const reason = classify(text);
      if (!reason)
        return;
      const modelID = e.properties?.modelID ?? e.properties?.model ?? e.properties?.modelID;
      const key = modelID ? `opencode/${modelID}` : undefined;
      if (!key)
        return;
      const health = readHealth(worktree);
      if (health.unhealthy[key])
        return;
      health.unhealthy[key] = { at: new Date().toISOString(), reason };
      writeHealth(worktree, health);
      failedSessions++;
    },
    "chat.message": async (input, output) => {
      if (failedSessions === 0)
        return;
      if (warned)
        return;
      warned = true;
      const parts = output.parts ?? [];
      const last = parts[parts.length - 1];
      if (last?.type === "text") {
        last.text = `${last.text}

${WARN_TEXT}`;
        return;
      }
      writeHealth(worktree, readHealth(worktree));
    }
  };
};
function applyProfileToConfig(cfg, profileId) {
  try {
    const p = loadProfile(profileId);
    const model = `${p.provider}/${p.model}`;
    cfg.model = model;
    cfg.small_model = model;
    const variant = p.effort?.default;
    if (p.effort?.levels?.length && variant)
      cfg.variant = variant;
    else
      delete cfg.variant;
    for (const [role, want] of Object.entries(p.roles ?? {})) {
      const agent = cfg.agent ?? (cfg.agent = {});
      const existing = agent[role] ?? (agent[role] = {});
      existing.model = model;
      const level = resolveEffort(p.effort?.levels ?? [], want);
      if (level)
        existing.variant = level;
      else
        delete existing.variant;
    }
    if (cfg.compaction) {
      cfg.compaction.prune = true;
      cfg.compaction.reserved = reservedTokens(p);
    }
    cfg.harness = { ...cfg.harness ?? {}, profile: profileId, threshold: pruneThreshold(p) };
  } catch {}
}

// src/telemetry.ts
import { appendFileSync, mkdirSync as mkdirSync2, existsSync as existsSync4, statSync, renameSync } from "node:fs";
import { join as join4 } from "node:path";
var MAX_BYTES = 4 * 1024 * 1024;
function logPath(dir) {
  return join4(dir, "telemetry.jsonl");
}
function rotate(file) {
  try {
    if (existsSync4(file) && statSync(file).size > MAX_BYTES) {
      renameSync(file, `${file}.1`);
    }
  } catch {}
}
function write(dir, record) {
  try {
    if (!existsSync4(dir))
      mkdirSync2(dir, { recursive: true });
    const file = logPath(dir);
    rotate(file);
    appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), ...record }) + `
`);
  } catch {}
}
var TelemetryPlugin = async ({ worktree }) => {
  const dir = join4(worktree, ".space");
  const started = Date.now();
  return {
    event: async ({ event }) => {
      const type = event?.type;
      if (typeof type !== "string")
        return;
      if (/error|rate|limit|quota/i.test(type)) {
        write(dir, { kind: "provider-event", type, detail: truncate2(safeStringify(event)) });
      }
    },
    "tool.execute.after": async (input, output) => {
      const text = typeof output?.output === "string" ? output.output : "";
      if (text.includes("[opencode-harness-kit] blocked")) {
        write(dir, { kind: "guard", tool: input.tool, rule: extractRule(text) });
        return;
      }
      const command = String(input.args?.command ?? "");
      if (input.tool === "bash" && /git push|rm -rf|chmod 777/.test(command)) {
        write(dir, { kind: "guard-attempt", tool: input.tool, command: truncate2(command) });
      }
    },
    dispose: async () => {
      write(dir, { kind: "session", uptimeMs: Date.now() - started });
    }
  };
};
function extractRule(output) {
  const m = output.match(/blocked:\s*([^\n]+)/);
  return m ? m[1].trim() : "unknown";
}
function truncate2(s, n = 300) {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// src/effort.js
var MANAGED_ROLES = ["plan", "build", "reviewer", "scout", "verify"];
function planEffort(profileId) {
  const p = loadProfile(profileId);
  const levels = p.effort?.levels ?? [];
  const roles = resolveRoles(p);
  const notes = [];
  if (levels.length === 0) {
    notes.push(`${p.model} publishes no tunable reasoning effort; variant will be omitted for every role.`);
  }
  for (const [role, want] of Object.entries(p.roles ?? {})) {
    const got = roles[role];
    if (want && got && want !== got) {
      notes.push(`role ${role} asked for ${want}; ${p.model} tops out at ${got}.`);
    }
  }
  return {
    profileId,
    model: `${p.provider}/${p.model}`,
    defaultVariant: resolveDefaultVariant(p),
    roles,
    notes
  };
}
function applyEffort(config, result, opts = {}) {
  const cfg = config;
  cfg.model = result.model;
  cfg.agent = cfg.agent ?? {};
  for (const role of MANAGED_ROLES) {
    const level = result.roles[role];
    if (level === undefined)
      continue;
    const existing = cfg.agent[role] ?? {};
    if (!existing.model)
      existing.model = result.model;
    if (level === null)
      delete existing.variant;
    else
      existing.variant = level;
    cfg.agent[role] = existing;
  }
  cfg.harness = opts.fallbackProfileId ? { profile: result.profileId, fallback: opts.fallbackProfileId } : { profile: result.profileId };
  return config;
}

// src/index.ts
var HarnessPlugin = async (ctx, options) => {
  const opts = options ?? {};
  const want = new Set(opts.only ?? ["guard", "prune", "router", "telemetry"]);
  const plugins = [];
  if (want.has("guard"))
    plugins.push(GuardPlugin);
  if (want.has("telemetry"))
    plugins.push(TelemetryPlugin);
  if (want.has("router"))
    plugins.push(RouterPlugin);
  if (want.has("prune"))
    plugins.push(PrunePlugin);
  const merged = {};
  for (const p of plugins) {
    const hooks = await p(ctx, {});
    for (const [name, fn] of Object.entries(hooks)) {
      const existing = merged[name];
      merged[name] = typeof existing === "function" && typeof fn === "function" ? async (...a) => {
        await existing(...a);
        await fn(...a);
      } : fn;
    }
  }
  const routerConfig = merged["config"];
  merged["config"] = async (config) => {
    if (routerConfig)
      await routerConfig(config);
    const id = opts.profile ?? config?.harness?.profile ?? profileIdFromConfig();
    if (!id)
      return;
    try {
      applyEffort(config, planEffort(id));
      const dir = join5(ctx.worktree, ".space");
      mkdirSync3(dir, { recursive: true });
      writeFileSync2(join5(dir, "active"), `${id}
`);
    } catch {}
  };
  return merged;
};
var src_default = HarnessPlugin;
export {
  src_default as default,
  HarnessPlugin
};
