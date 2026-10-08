/**
 * Codegraph schema — co-change bundle task ids (bd tea-rags-mcp-09c4m).
 *
 * `cg_temporal_bundle_commits.task_ids`: the JSON array of task ids the
 * admitted bundle's commit message names, read by the git trajectory's
 * `extractTaskIds` — `[]` when it names none. Shotgun surgery joins one
 * author burst's commits naming a common task into one logical change.
 *
 * Nullable, no DEFAULT: a row written before this column reads as "not
 * recorded", never as "no task", and the join falls back to structure alone
 * until the next co-change build fills it.
 *
 * A separate migration rather than an edit of the unreleased 044: dev graph
 * databases already applied 044, and the runner never re-runs an applied
 * migration, so the build's write would fail on them.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_045_CG_TEMPORAL_BUNDLE_TASK_IDS = `
ALTER TABLE cg_temporal_bundle_commits ADD COLUMN IF NOT EXISTS task_ids VARCHAR;
`;
