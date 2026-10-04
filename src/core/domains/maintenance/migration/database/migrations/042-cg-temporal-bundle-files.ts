/**
 * Codegraph schema — admitted-bundle file membership (bd tea-rags-mcp-c3v6o,
 * A5 phase 1).
 *
 * `cg_temporal_bundle_files`: one row per (bundle, file) of every bundle the
 * co-change build admitted, `bundle_id` = the extraction-order index the
 * builder's snapshot carries. The pair tables of migration 031 cannot answer
 * component-level questions — `support(A,B) = |bundles touching both|` and
 * `changes(A) = |bundles touching A|` — because the per-file partner cap
 * truncates the pair set and a pair's support counts a multi-file bundle once
 * per PAIR, not once per bundle. The split/merge verdicts of
 * `get_architecture_report` read exactly these counts.
 *
 * Wholesale rewrite with the rest of the co-change build
 * (`DuckDbTemporalCochangeStore#replace`), so the table is recreated rather
 * than DELETEd — the codegraph navigator records why a keyed DuckDB table
 * otherwise keeps every deleted generation in the file. An index built before
 * this migration keeps an empty table until its next co-change build; the
 * report's `splitMerge` block reports that as not built rather than as clean.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_042_CG_TEMPORAL_BUNDLE_FILES = `
CREATE TABLE IF NOT EXISTS cg_temporal_bundle_files (
  bundle_id  INTEGER NOT NULL,
  rel_path   VARCHAR NOT NULL,
  PRIMARY KEY (bundle_id, rel_path)
);
`;
