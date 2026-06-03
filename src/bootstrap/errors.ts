/**
 * Bootstrap config error re-exports.
 *
 * The hierarchy itself (`ConfigError`, `ConfigValueInvalidError`,
 * `ConfigValueMissingError`, `ConfigNotInitializedError`) now lives in
 * `core/infra/errors.ts` so every layer can reach it without an upward import
 * (`adapters`/`domains`/`api`/`mcp` → `bootstrap` is forbidden by the
 * dependency-direction matrix). External consumers should import from
 * `core/infra/errors.js` (or via the `api/public` re-export for cli/mcp).
 */

export {
  ConfigError,
  ConfigValueInvalidError,
  ConfigValueMissingError,
  ConfigNotInitializedError,
} from "../core/infra/errors.js";
export type { ConfigErrorCode } from "../core/infra/errors.js";
