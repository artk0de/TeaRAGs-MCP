/**
 * Codegraph schema — CHA edge kinds + resolve-stats surface
 * (bd tea-rags-mcp-2jet / tea-rags-mcp-j431).
 *
 * Adds `edge_kind` (`exact` | `cone` | `poly-base`) and `confidence` (REAL, 1/N
 * dampening for cone fan-out) to `cg_symbols_edges_method`, and a `cg_run_stats`
 * table holding the per-receiver-kind resolve breakdown (one row per kind,
 * overwritten each run) so it is readable via the daemon proxy.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_006_CG_EDGE_KIND = `
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS edge_kind VARCHAR DEFAULT 'exact';
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1.0;

CREATE TABLE IF NOT EXISTS cg_run_stats (
  receiver_kind VARCHAR PRIMARY KEY,
  attempted     INTEGER NOT NULL,
  resolved      INTEGER NOT NULL
);
`;
