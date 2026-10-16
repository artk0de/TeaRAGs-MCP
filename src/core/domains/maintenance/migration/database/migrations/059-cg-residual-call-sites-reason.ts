/**
 * Codegraph schema — why a residual call site carries the menu it does (bd
 * tea-rags-mcp-2m83f.48).
 *
 * `reason = 'frameworkOverride'` marks a site whose callee is a Rails framework
 * member the static pass would have called external, but a project override of
 * that member is reachable; its menu holds only those overrides. NULL = the
 * ordinary short-name menu, which every row written before 059 has.
 * Nullable, no DEFAULT.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_059_CG_RESIDUAL_CALL_SITES_REASON = `
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS reason VARCHAR;
`;
