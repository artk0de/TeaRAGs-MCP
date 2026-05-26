/**
 * Pure graph algorithms — foundation layer (`core/infra/`), importable by any
 * layer above (adapters AND domains). Moved out of the codegraph trajectory so
 * the codegraph daemon (an adapter) can run SCC/PageRank without an
 * adapter->domain import.
 */

export { tarjanScc, type AdjacencyMap, type Scc } from "./tarjan-scc.js";
export { pageRank, type PageRankOptions, type PageRankResult } from "./page-rank.js";
