/**
 * Codegraph schema — co-change bundle rename-sweep verdict (bd
 * tea-rags-mcp-v2525).
 *
 * `cg_temporal_bundle_commits.rename_sweep`: whether the admitted bundle's
 * commit is an identifier rename sweep — one commit-wide identifier
 * substitution turns everything it removed into everything it added. Shotgun
 * surgery leaves such a commit out of its history, like a line-count sweep.
 *
 * Nullable, no DEFAULT: a row written before this column reads as "not
 * assessed", and the stage stays off until the next co-change build fills it
 * (`COCHANGE_ALGORITHM_REVISION` 5 forces that build).
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_052_CG_TEMPORAL_BUNDLE_RENAME_SWEEP = `
ALTER TABLE cg_temporal_bundle_commits ADD COLUMN IF NOT EXISTS rename_sweep BOOLEAN;
`;
