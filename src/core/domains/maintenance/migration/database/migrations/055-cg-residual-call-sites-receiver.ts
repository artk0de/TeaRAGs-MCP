/**
 * Codegraph schema — the `cg_run_stats` slice of each residual call site (bd
 * tea-rags-mcp-2m83f.38).
 *
 * `language` and `receiver_kind` (the run-stats `ReceiverKind` taxonomy) name
 * the per-(language, receiverKind) bucket the site was counted under, so a site
 * a model edge resolves moves out of that bucket's miss into resolved.
 *
 * A row written before 055 takes its file's `cg_symbols_files.language` — the
 * same extraction language the walker stamps on new rows — so its site lands in
 * its language's rate without a re-walk. `receiver_kind` stays NULL until the
 * file is re-walked: the walker classifies it from the receiver's AST node,
 * which the row does not keep. Nullable, no DEFAULT.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_055_CG_RESIDUAL_CALL_SITES_RECEIVER = `
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS language VARCHAR;
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS receiver_kind VARCHAR;
UPDATE cg_residual_call_sites r SET language = f.language
  FROM cg_symbols_files f
 WHERE f.rel_path = r.source_rel_path AND r.language IS NULL;
`;
