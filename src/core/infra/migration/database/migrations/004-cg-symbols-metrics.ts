/**
 * Slice 2 codegraph schema — `cg_symbols_metrics`.
 *
 * Persists per-symbol graph metrics that are too expensive to compute
 * at rerank time. Slice 2 ships PageRank only; future Tier 3 signals
 * (betweenness, closeness) can extend this table with additional
 * columns rather than spinning up new tables.
 *
 * page_rank stays normalised so that sum(page_rank) ≈ 1 when the graph
 * has no dangling nodes; for typical codegraphs with leaf utilities,
 * sum stays slightly below 1 and the relative ordering is still
 * meaningful — that's the only thing rerankers depend on.
 */
export const SQL_004_CG_SYMBOLS_METRICS = `
CREATE TABLE IF NOT EXISTS cg_symbols_metrics (
  symbol_id   VARCHAR PRIMARY KEY,
  page_rank   DOUBLE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_metrics_page_rank ON cg_symbols_metrics (page_rank);
`;
