/**
 * Pure graph algorithms — primitives layer (`core/primitives/`), importable by any
 * layer above (adapters AND domains). Moved out of the codegraph trajectory so
 * the codegraph daemon (an adapter) can run SCC/PageRank without an
 * adapter->domain import.
 */

export { tarjanScc, type AdjacencyMap, type Scc } from "./tarjan-scc.js";
export { pageRank, type PageRankOptions, type PageRankResult } from "./page-rank.js";
export {
  otsuSplit,
  resolveMajorityFlooredOtsuThreshold,
  type MajorityFlooredOtsuOptions,
  type MajorityFlooredOtsuThreshold,
  type OtsuSplit,
} from "./otsu-split.js";
export {
  DEFAULT_VISIBILITY_BITSET_WORDS,
  transitiveVisibility,
  type TransitiveVisibility,
  type TransitiveVisibilityOptions,
} from "./transitive-visibility.js";
export {
  weightThresholdComponents,
  type WeightedComponent,
  type WeightedComponentAnalysis,
  type WeightedNodeEdge,
} from "./weight-threshold-components.js";
