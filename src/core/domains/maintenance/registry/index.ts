/**
 * Project Registry barrel.
 *
 * Foundation layer — no domain deps. See
 * docs/superpowers/specs/2026-05-12-project-registry-design.md §3.
 */

export type {
  AutoUpdateRunRecord,
  CollectionEntry,
  ProjectInfo,
  RecordEntryInput,
  RegistryAutoUpdateConfig,
  RegistryFileV1,
  RegistryGitState,
} from "../../../contracts/types/registry.js";
export { PROJECT_NAME_RE } from "./constants.js";
export { loadRegistryFile, saveRegistryFile } from "./registry-file.js";
export { CollectionRegistry } from "./collection-registry.js";
export {
  ADAPTIVE_DEFAULT_ENV_KEYS,
  DEDICATED_FIELD_ENV_KEYS,
  REGISTRY_ENV_ALLOWLIST,
  REGISTRY_ENV_GROUPS,
} from "./env-groups.js";
export type { RegistryEnvGroup } from "./env-groups.js";
export { replayRegistryEnv } from "./env-replay.js";
export { pickRegistryEntry, resolveRegistryEnv } from "./env-resolution.js";
export type { RegistryLookup } from "./env-resolution.js";
