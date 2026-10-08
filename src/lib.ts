// Public library surface.
//
// Kept apart from src/index.ts on purpose: opencode calls every function
// exported by a plugin module, so a helper re-exported there would be invoked
// as if it were a plugin and fail at load time.
//
// Import from here in code and tests:
//   import { loadProfile, resolveEffort } from "opencode-harness-kit/profile"

export {
  ROOT,
  ProfileError,
  loadProfile,
  loadRetention,
  listProfileIds,
  listProfileIds as profiles,
  normalize,
  profileDirs,
  profilePath,
  pruneThreshold,
  reservedTokens,
  resolveDefaultVariant,
  resolveEffort,
  resolveRoles,
  retentionFor,
  validate,
} from "./profile.js"

export {
  BASH_ALLOWLIST,
  BASH_DENYLIST,
  generateConfig,
} from "./config.js"

export { applyEffort, planEffort, MANAGED_ROLES } from "./effort.js"

export {
  BASH_RULES as GUARD_BASH_RULES,
  WRITE_RULES as GUARD_WRITE_RULES,
  checkBash,
  checkWrite,
  ruleNames,
  segments,
} from "./rules.js"