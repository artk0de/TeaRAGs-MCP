/**
 * Codegraph schema — residual call sites (bd tea-rags-mcp-2m83f, codegraph
 * residual resolution wave 1).
 *
 * One row per call site the static resolve left without a confident edge: an
 * over-cap ambiguous fan-out, or a receiver with no type evidence. Written per
 * source file by the same scoped reconciliation as the edge tables, read by the
 * residual pass. `candidates` is a JSON array of target symbol ids in a
 * VARCHAR, the convention of `cg_temporal_bundle_commits.task_ids` (045);
 * `call_column` rather than `column` keeps clear of the SQL keyword.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_053_CG_RESIDUAL_CALL_SITES = `
CREATE TABLE IF NOT EXISTS cg_residual_call_sites (
  source_rel_path   VARCHAR NOT NULL,
  site_key          VARCHAR NOT NULL,
  method_symbol_id  VARCHAR NOT NULL,
  method_start_line INTEGER NOT NULL,
  method_end_line   INTEGER NOT NULL,
  line              INTEGER NOT NULL,
  call_column       INTEGER NOT NULL,
  receiver_text     VARCHAR NOT NULL,
  member            VARCHAR NOT NULL,
  kind              VARCHAR NOT NULL,
  candidates        VARCHAR NOT NULL,
  menu_hash         VARCHAR NOT NULL,
  menu_overflow     BOOLEAN NOT NULL,
  PRIMARY KEY (source_rel_path, site_key)
);

CREATE INDEX IF NOT EXISTS idx_cg_residual_call_sites_site_key
  ON cg_residual_call_sites (site_key);
`;
