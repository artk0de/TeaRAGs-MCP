/**
 * Codegraph schema — the `cg_run_stats` slice of each residual call site (bd
 * tea-rags-mcp-2m83f.38).
 *
 * `language` and `receiver_kind` (the run-stats `ReceiverKind` taxonomy) name
 * the per-(language, receiverKind) bucket the site was counted under, so a site
 * a model edge resolves moves out of that bucket's miss into resolved.
 *
 * Nullable, no DEFAULT: a row written before 055 reads NULL until its file is
 * re-walked; the status tally counts it under the aggregate only.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_055_CG_RESIDUAL_CALL_SITES_RECEIVER = `
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS language VARCHAR;
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS receiver_kind VARCHAR;
`;
