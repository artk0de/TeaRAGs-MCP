/**
 * Codegraph schema — admitted-bundle commit ids (bd tea-rags-mcp-89k7k.1.14).
 *
 * `cg_temporal_bundle_commits`: one row per bundle the co-change build
 * admitted, `bundle_id` the same extraction-order index
 * `cg_temporal_bundle_files` (migration 042) carries, `commit_shas` the JSON
 * array of the bundle's member commits (one per commit, several per author
 * session) — a JSON array for the reason `sample_commits` is one: set
 * arithmetic happens read-side. A review's co-change significance test drops
 * every bundle holding one of the diff's own commits from the history, so the
 * change cannot confirm itself.
 *
 * Wholesale rewrite with the rest of the co-change build, recreated rather
 * than DELETEd (`DuckDbTemporalCochangeStore#replace`). An index built before
 * this migration keeps an empty table until its next co-change build — the
 * builder's algorithm revision bump forces that build on the next index run —
 * and a review reports `diffHistory.bundleCommitsAvailable: false` until then.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_043_CG_TEMPORAL_BUNDLE_COMMITS = `
CREATE TABLE IF NOT EXISTS cg_temporal_bundle_commits (
  bundle_id    INTEGER NOT NULL PRIMARY KEY,
  commit_shas  VARCHAR NOT NULL
);
`;
