/**
 * Codegraph schema — co-change bundle file line counts (bd tea-rags-mcp-dm61n).
 *
 * `cg_temporal_bundle_files.lines_added` / `lines_deleted`: the +/- line counts
 * the admitted bundle's commit made to that file (git numstat, summed over the
 * rows rename resolution maps onto one HEAD path).
 *
 * Nullable, no DEFAULT: a row written before these columns reads as "not
 * recorded", never as "zero lines", until the next co-change build fills it —
 * `COCHANGE_ALGORITHM_REVISION` 3 forces that build once.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_046_CG_TEMPORAL_BUNDLE_FILE_LINES = `
ALTER TABLE cg_temporal_bundle_files ADD COLUMN IF NOT EXISTS lines_added INTEGER;
ALTER TABLE cg_temporal_bundle_files ADD COLUMN IF NOT EXISTS lines_deleted INTEGER;
`;
