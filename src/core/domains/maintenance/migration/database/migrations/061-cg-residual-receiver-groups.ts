/**
 * Codegraph schema — the receiver group of each residual call site (bd
 * tea-rags-mcp-2m83f.46, residual wave 1.5).
 *
 * `receiver_group` — sha1 of the site's receiver group: every residual call on
 * one receiver in one method shares it, and the residual pass asks the group one
 * "which class" question. `class_targets` — JSON `[[class, target], …]`, the
 * group's narrowed class set uncut, each class with the method this site's
 * member reaches on it. Both NULL on a row written before 061 or by a walk
 * without narrowing: such a site is asked on its own candidates until its file
 * is re-walked. Nullable, no DEFAULT.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_061_CG_RESIDUAL_RECEIVER_GROUPS = `
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS receiver_group VARCHAR;
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS class_targets VARCHAR;
`;
