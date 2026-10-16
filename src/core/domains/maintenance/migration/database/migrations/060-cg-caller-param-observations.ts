/**
 * Codegraph schema — caller observations parameter types are folded from (bd
 * tea-rags-mcp-2m83f.49), and the `paramTyped` counter.
 *
 * `cg_caller_param_observations`: one row per caller file — the JSON array of
 * its call sites whose callee is one exact static edge, each the callee and the
 * argument types as the caller-parameter pass observed them (`target`,
 * `positional`, `keyword`, `argCount`, `hasKwargSplat`; a `null` type is an
 * untyped argument). One row per file because the observations are only ever
 * read and replaced whole, and the row diff keys on text columns. Written on
 * the same per-source-file row diff as the edges, so a
 * re-walk replaces a file's rows and a deletion removes them. An incremental run
 * folds the rows of the files it did not walk with what it observed fresh, which
 * is what keeps its parameter types equal to a full run's.
 *
 * `param_typed` on the run breakdown and on the per-file tally it sums from:
 * call sites resolved on a receiver rooted at a caller-typed parameter (a
 * subset of `resolved`). DEFAULT 0 backfills — "typed nothing from callers".
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_060_CG_CALLER_PARAM_OBSERVATIONS = `
CREATE TABLE IF NOT EXISTS cg_caller_param_observations (
  source_rel_path VARCHAR NOT NULL PRIMARY KEY,
  observations    VARCHAR NOT NULL
);
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS param_typed BIGINT DEFAULT 0;
ALTER TABLE cg_file_resolve_stats ADD COLUMN IF NOT EXISTS param_typed INTEGER DEFAULT 0;
`;
