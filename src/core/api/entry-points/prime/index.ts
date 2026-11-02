/** Registry-only composition seam for agent startup; no App/server assembly. */
export { CollectionRegistry } from "../../../domains/maintenance/registry/index.js";
export { IndexFreshnessCheck } from "../../../domains/maintenance/freshness/freshness-check.js";
export { resolveWorkingTree } from "../../internal/collection-resolver.js";
export type { CollectionEntry } from "../../../contracts/types/registry.js";
