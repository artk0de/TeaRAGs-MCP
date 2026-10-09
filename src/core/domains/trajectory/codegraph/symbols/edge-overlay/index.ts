/**
 * Edge overlays over the indexed file graph (bd tea-rags-mcp-89k7k.35.19): the
 * pure per-review view and its application to the architecture report's graph
 * facts. Producers (the review_changes working-tree reader, a what-if overlay)
 * live in api; the value and its algebra live here.
 */
export { ReviewEdgeOverlay, type ReviewEdgeSkipReason, type ReviewFileEdgeRead } from "./review-edge-overlay.js";
export {
  ARCHITECTURE_FACTS_NOT_REFRESHED_BY_EDGE_OVERLAY,
  applyEdgeOverlay,
  type ArchitectureEdgeOverlayNotJudgedFile,
  type ArchitectureEdgeOverlaySource,
  type ArchitectureEdgeOverlayState,
  type ArchitectureEdgeOverlayTargetFacts,
  type ArchitectureFactNotRefreshedByEdgeOverlay,
} from "./architecture-edge-overlay.js";
