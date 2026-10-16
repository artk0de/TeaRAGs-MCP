/**
 * Codegraph schema — the downstream hop of each residual call site (bd
 * tea-rags-mcp-2m83f.51, residual wave 1.5).
 *
 * `downstream_group` — the `receiver_group` of the chain hop whose receiver is
 * this call (`record.firm` for `record.firm.name`): a class the residual pass
 * accepts for this site's group, through the return type `class_targets` carries
 * third, becomes a type fact on that group. NULL on a row written before 062 and
 * on a row whose class targets carry no return type. Nullable, no DEFAULT.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_062_CG_RESIDUAL_DOWNSTREAM_GROUP = `
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS downstream_group VARCHAR;
`;
