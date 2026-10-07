// Plugin entry point.
//
// Each concern lives in its own module so a project can install the ones it
// wants. The shared core is plain JS with JSDoc types, which lets the CLI run
// under node while opencode loads the TypeScript hooks.
//
// Nothing here names a model. Which model is in use, what effort each role
// gets, and how much context to reserve all come from a profile.

import type { Plugin } from "@opencode-ai/plugin"
import { GuardPlugin } from "./guard.js"
import { PrunePlugin } from "./prune.js"
import { RouterPlugin } from "./router.js"
import { TelemetryPlugin } from "./telemetry.js"
import { applyEffort, planEffort } from "./effort.js"
import { listProfileIds, loadProfile } from "./profile.js"

export interface HarnessOptions {
  /** Profile id. Defaults to the one marked default in profiles/index.json. */
  profile?: string
  /** Load a subset. Defaults to all four. */
  only?: Array<"guard" | "prune" | "router" | "telemetry">
}

export const HarnessPlugin: Plugin = async (ctx, options?: HarnessOptions) => {
  const opts = (options ?? {}) as HarnessOptions
  const want = new Set(opts.only ?? ["guard", "prune", "router", "telemetry"])

  const plugins: Plugin[] = []
  if (want.has("guard")) plugins.push(GuardPlugin)
  if (want.has("telemetry")) plugins.push(TelemetryPlugin)
  if (want.has("router")) plugins.push(RouterPlugin)
  if (want.has("prune")) plugins.push(PrunePlugin)

  const merged: Record<string, any> = {}
  for (const p of plugins) {
    const hooks = await p(ctx, {})
    for (const [name, fn] of Object.entries(hooks)) {
      const existing = merged[name]
      merged[name] =
        typeof existing === "function" && typeof fn === "function"
          ? async (...a: unknown[]) => {
              await existing(...a)
              await (fn as (...b: unknown[]) => unknown)(...a)
            }
          : fn
    }
  }

  // Effort assignment belongs to the config hook, which runs once at startup.
  // Chain it after the router so a failover profile wins.
  const routerConfig = merged["config"]
  merged["config"] = async (config: any) => {
    if (routerConfig) await routerConfig(config)
    const id = opts.profile ?? config?.harness?.profile
    if (!id) return
    try {
      applyEffort(config, planEffort(id))
    } catch {
      // Never block startup on a bad profile.
    }
  }

  return merged as any
}

export default HarnessPlugin

export { listProfileIds, loadProfile }
export { planEffort, applyEffort } from "./effort.js"
export { resolveEffort, pruneThreshold, reservedTokens } from "./profile.js"
