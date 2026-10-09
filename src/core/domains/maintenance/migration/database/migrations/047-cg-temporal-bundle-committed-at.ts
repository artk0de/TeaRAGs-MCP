/**
 * Codegraph schema — co-change bundle commit time (bd tea-rags-mcp-zf9yz).
 *
 * `cg_temporal_bundle_commits.committed_at`: the admitted bundle's commit time
 * in unix seconds — the chronology shotgun surgery's lifecycle test orients
 * pairs by. Bundle ids are a storage order (newest first today) and never
 * stand in for it.
 *
 * Nullable, no DEFAULT: a row written before this column reads as "not
 * recorded", and the lifecycle stage stays off until the next co-change build
 * fills it.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_047_CG_TEMPORAL_BUNDLE_COMMITTED_AT = `
ALTER TABLE cg_temporal_bundle_commits ADD COLUMN IF NOT EXISTS committed_at BIGINT;
`;
