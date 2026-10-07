/**
 * Codegraph schema — co-change author bursts (bd tea-rags-mcp-3vg0x).
 *
 * The co-change build now writes one bundle per commit and counts a file or a
 * pair at most once per author burst (one identity's commits less than W
 * apart), with W derived from the repository's own history.
 *
 * `cg_temporal_bundle_commits.burst_id`: the admitted bundle's burst, so the
 * significance gate can count per burst too. `cg_temporal_meta`:
 * `admitted_burst_count` (N, the universe the rules are counted over),
 * `burst_window_minutes` and `burst_window_method` (`estimated` | `fallback`).
 * `session_gap_minutes` is retired — no build writes it any more; it stays as a
 * dead nullable column rather than a DROP on a keyed table.
 *
 * Nullable, no DEFAULT: a row written before these columns predates burst
 * dedup and reads as "unknown", never as zeros. The builder's algorithm
 * revision forces a rebuild on the next index run, which fills them.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_044_CG_TEMPORAL_BURSTS = `
ALTER TABLE cg_temporal_bundle_commits ADD COLUMN IF NOT EXISTS burst_id INTEGER;
ALTER TABLE cg_temporal_meta ADD COLUMN IF NOT EXISTS admitted_burst_count INTEGER;
ALTER TABLE cg_temporal_meta ADD COLUMN IF NOT EXISTS burst_window_minutes INTEGER;
ALTER TABLE cg_temporal_meta ADD COLUMN IF NOT EXISTS burst_window_method VARCHAR;
`;
