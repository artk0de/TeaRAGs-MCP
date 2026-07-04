/**
 * Project Registry barrel.
 *
 * Foundation layer — no domain deps. See
 * docs/superpowers/specs/2026-05-12-project-registry-design.md §3.
 */

export type { CollectionEntry, ProjectInfo, RecordEntryInput, RegistryFileV1 } from "./types.js";
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
