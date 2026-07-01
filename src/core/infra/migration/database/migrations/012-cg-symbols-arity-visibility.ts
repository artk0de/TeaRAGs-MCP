/**
 * Codegraph schema — persist def-shape signature on cg_symbols (bd tfepp/d9o7o).
 *
 * arity/visibility (xlnub) + kwargs/block (d9o7o) flow walker→provider→symbol
 * table on a FULL reindex but were never persisted, so a daemon cold-start
 * INCREMENTAL reindex hydrated unchanged-file candidates without them and the
 * arity/visibility/kwarg/block narrowers degraded to no-op for those files.
 * Persist all four.
 *
 * All nullable (existing rows + non-method symbols). DuckDB rejects NOT NULL on
 * ALTER ADD COLUMN; NULL = "unknown", which the narrowers already treat as keep
 * (conservatism invariant). arity_json / kwargs_json store the JSON-encoded
 * envelope; visibility is the bare string; accepts_block is a nullable boolean.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_012_CG_SYMBOLS_ARITY_VISIBILITY = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS arity_json VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS visibility VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS kwargs_json VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS accepts_block BOOLEAN;
`;
