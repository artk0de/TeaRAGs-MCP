/**
 * Narrow read for the bootstrap auto-update watcher (bd tea-rags-mcp-54xwd.3
 * follow-up).
 *
 * `bootstrap/auto-update/{trigger,mcp-hint}.ts` importing the api assembly
 * barrel (`../index.ts`) gave the auto-update component an SDP edge into the
 * churning api component; importing the declaring domain leaves directly
 * broke the composition-root direction pin (bootstrap reaches domains only
 * through `core/api`, `domain-boundaries.md`). This file re-exports only what
 * the watcher needs and declares nothing, so the component-SDP judge treats it
 * as a transparent re-export shim (bd tea-rags-mcp-ciq4d) and judges the edge
 * against the ultimate freshness / registry targets.
 */
export {
  AUTO_UPDATE_RUN_TTL_MS,
  IndexFreshnessCheck,
  type IndexFreshnessVerdict,
} from "../../../domains/maintenance/freshness/index.js";
export {
  collectionHoldsCodegraphData,
  CollectionRegistry,
  outerEnvForRegistryEntry,
  type CollectionEntry,
} from "../../../domains/maintenance/registry/index.js";
