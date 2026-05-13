/**
 * Project Registry barrel.
 *
 * Foundation layer — no domain deps. See
 * docs/superpowers/specs/2026-05-12-project-registry-design.md §3.
 */

export type { CollectionEntry, ProjectInfo, RecordEntryInput, RegistryFileV1 } from "./types.js";
export { RegistryFileCorruptedError, RegistryWriteError, RegistryConcurrencyError } from "./errors.js";
export { PROJECT_NAME_RE } from "./constants.js";
export { loadRegistryFile, saveRegistryFile } from "./registry-file.js";
export { CollectionRegistry, ProjectNameNotUniqueError } from "./collection-registry.js";
