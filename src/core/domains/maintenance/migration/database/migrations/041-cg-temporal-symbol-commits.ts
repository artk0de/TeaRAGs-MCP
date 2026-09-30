/**
 * Codegraph schema — intra-file symbol commit sets (bd tea-rags-mcp-3gz4f,
 * S1 of symbol co-change).
 *
 * The temporal sub-graph's symbol-level half beside the file-level tables of
 * migration 031: per (rel_path, symbol_id), the commits whose hunks touched
 * that symbol's chunk lines — the walk's own offset tracking collapsed from
 * chunk ids to symbols (`#partN` windows unioned into the parent, block chunks
 * without a symbolId dropped). `commit_shas` is a JSON array for the same
 * reason `cg_temporal_edges_cochange.sample_commits` is: evidence and set
 * arithmetic happen read-side, never joined on in SQL.
 *
 * Written by the temporal completion hook from the run-scoped buffer the git
 * chunk walk absorbs into (bd tea-rags-mcp-3gz4f): replace per flushed file,
 * prune rows of files the live set lost. NOT a wholesale rewrite — the file
 * pairs above are a function of (HEAD, parameters, deletions) and rebuild
 * wholesale; symbol rows are a function of each file's last walk and are
 * replaced per file.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_041_CG_TEMPORAL_SYMBOL_COMMITS = `
CREATE TABLE IF NOT EXISTS cg_temporal_symbol_commits (
  rel_path     VARCHAR NOT NULL,
  symbol_id    VARCHAR NOT NULL,
  commit_shas  VARCHAR NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);
`;
