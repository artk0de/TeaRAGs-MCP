-- Codegraph CHA edge kinds (bd tea-rags-mcp-2jet) + resolve-stats surface
-- (bd tea-rags-mcp-j431).
--
-- `edge_kind` distinguishes exact resolution from CHA devirtualization edges:
--   'exact'     — receiver/ancestor method pinned directly (today's behaviour)
--   'cone'      — bounded polymorphic fan-out to overriding subtypes (|cone| ≤ K)
--   'poly-base' — hub fan-out capped: one edge to the base declaration, full
--                 expansion deferred to query-time getSubtypes
-- `confidence` carries 1/N dampening for cone edges (1.0 for exact).
--
-- cg_run_stats persists the per-receiver-kind resolve breakdown — one row per
-- kind, overwritten each enrichment run — so it is readable via the daemon
-- proxy (getRunStats) instead of relying on worker stderr that the MCP host
-- does not capture.

-- DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
-- supported"); DEFAULT alone backfills existing rows and new inserts.
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS edge_kind VARCHAR DEFAULT 'exact';
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1.0;

CREATE TABLE IF NOT EXISTS cg_run_stats (
  receiver_kind VARCHAR PRIMARY KEY,
  attempted     INTEGER NOT NULL,
  resolved      INTEGER NOT NULL
);
