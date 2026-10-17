/**
 * Codegraph schema — schema-column answers of the residual pass (bd
 * tea-rags-mcp-2m83f.55, residual wave 1.5).
 *
 * `cg_residual_external_sites.outcome`: `external` — the model put the site's
 * target outside the project; `attribute` — the class it picked reads the member
 * as a schema column, which has no method node to edge to. Both leave the recall
 * denominator. Every row written before 064 is an `external` one.
 *
 * `schema_attribute` counts residual sites whose callee is a schema column
 * accessor on every class their receiver narrowed to: no in-project definition,
 * out of the recall denominator like `no_in_project_def`. On the run breakdown
 * and on the per-file tally it sums from; DEFAULT 0 reads as "none settled" for
 * a row written before 064.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_064_CG_RESIDUAL_SCHEMA_ATTRIBUTES = `
ALTER TABLE cg_residual_external_sites ADD COLUMN IF NOT EXISTS outcome VARCHAR DEFAULT 'external';
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS schema_attribute BIGINT DEFAULT 0;
ALTER TABLE cg_file_resolve_stats ADD COLUMN IF NOT EXISTS schema_attribute INTEGER DEFAULT 0;
`;
