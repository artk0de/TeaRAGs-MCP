/**
 * Codegraph schema — recreate `idx_cg_symbols_edges_file_target` over the rows
 * the table holds, second half of its one-time rebuild (bd tea-rags-mcp-m7png).
 *
 * 067 dropped the possibly drifted index in its own transaction; why the
 * rebuild is split across two migrations is 067's docblock. The definition is
 * 001's, so the result is the index a fresh database gets. The cost is one scan
 * of `cg_symbols_edges_file`.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_068_CG_CREATE_EDGE_FILE_TARGET_INDEX = `
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_file_target ON cg_symbols_edges_file (target_rel_path);
`;
