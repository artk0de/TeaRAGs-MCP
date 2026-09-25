/**
 * Codegraph schema — the temporal co-change sub-graph (bd tea-rags-mcp-x4rpp,
 * epic tea-rags-mcp-l1ot, Slice 5).
 *
 * The second sub-graph of the codegraph family, under the `cg_<subtype>_*`
 * namespace beside `cg_symbols_*`: which files change together in history,
 * measured as association rules over admitted commit bundles.
 *
 * - `cg_temporal_files` — per file, the admitted bundles that touched it (the
 *   antecedent count of every rule on it) and its newest change.
 * - `cg_temporal_edges_cochange` — one row per UNDIRECTED pair, `rel_path_a <
 *   rel_path_b`, carrying support, both directed confidences, lift, the newest
 *   co-change and up to three sample commit SHAs (a JSON array: evidence a
 *   report shows, never joined on).
 * - `cg_temporal_meta` — the single provenance row (`meta_key = 'cochange'`):
 *   the HEAD and parameter fingerprint the builder compares to decide whether a
 *   run rebuilds, plus the adaptive cuts the build chose.
 *
 * All three are wholesale rewrites (`DuckDbTemporalCochangeStore#replace`), so
 * each is recreated rather than DELETEd — the codegraph navigator records why a
 * keyed DuckDB table otherwise keeps every deleted generation in the file.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_031_CG_TEMPORAL_INIT = `
CREATE TABLE IF NOT EXISTS cg_temporal_files (
  rel_path         VARCHAR PRIMARY KEY,
  bundle_count     INTEGER NOT NULL,
  partner_count    INTEGER NOT NULL,
  last_changed_at  BIGINT  NOT NULL
);
CREATE TABLE IF NOT EXISTS cg_temporal_edges_cochange (
  rel_path_a         VARCHAR NOT NULL,
  rel_path_b         VARCHAR NOT NULL,
  support            INTEGER NOT NULL,
  confidence_ab      DOUBLE  NOT NULL,
  confidence_ba      DOUBLE  NOT NULL,
  lift               DOUBLE  NOT NULL,
  last_co_change_at  BIGINT  NOT NULL,
  sample_commits     VARCHAR NOT NULL,
  PRIMARY KEY (rel_path_a, rel_path_b)
);
CREATE TABLE IF NOT EXISTS cg_temporal_meta (
  meta_key               VARCHAR PRIMARY KEY,
  head                   VARCHAR NOT NULL,
  fingerprint            VARCHAR NOT NULL,
  built_at               BIGINT  NOT NULL,
  window_since           BIGINT  NOT NULL,
  commit_count           INTEGER NOT NULL,
  bundle_count           INTEGER NOT NULL,
  admitted_bundle_count  INTEGER NOT NULL,
  max_files_per_bundle   INTEGER NOT NULL,
  min_support            INTEGER NOT NULL,
  max_partners_per_file  INTEGER NOT NULL,
  session_gap_minutes    INTEGER
);
`;
