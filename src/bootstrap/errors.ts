/**
 * Bootstrap config error re-exports.
 *
 * The hierarchy itself (`ConfigError`, `ConfigValueInvalidError`,
 * `ConfigValueMissingError`, `ConfigNotInitializedError`) now lives in
 * `core/primitives/errors/` so every layer can reach it without an upward import
 * (`adapters`/`domains`/`api`/`mcp` → `bootstrap` is forbidden by the
 * dependency-direction matrix). External consumers should import from
 * `core/primitives/errors/index.js` (or via the `api/public` re-export for cli/mcp).
 */

export {
  ConfigError,
  ConfigValueInvalidError,
  ConfigValueMissingError,
  ConfigNotInitializedError,
} from "../core/primitives/errors/index.js";
export type { ConfigErrorCode } from "../core/primitives/errors/index.js";
