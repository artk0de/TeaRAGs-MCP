/**
 * Codegraph schema — drop `idx_cg_symbols_edges_file_target`, first half of its
 * one-time rebuild (bd tea-rags-mcp-m7png); 068 recreates it.
 *
 * 019 kept this index because `getFanIn` earns it, and said the table stays
 * exposed to ART drift. The drift arrived: the residual store's model file-edge
 * sync churns `cg_symbols_edges_file` with DELETE + INSERT, and taxdome's target
 * index ended up missing 26 `origin = 'model'` rows the table held (an equality
 * lookup returned 5 rows where a forced scan returned 6). The next walk's
 * DELETE over such a row failed with "Failed to delete all rows from index.
 * Only deleted 1 out of 2 rows" and invalidated the whole database. Builds from
 * now on keep the walk off those rows (the file-graph store's diff retains
 * them) and rebuild the index after every sync
 * (`DuckDbResidualEdgeStore#applyModelEdges`). A database written before that
 * still carries the drifted index, so 067 + 068 rebuild it on the next open,
 * in-process and daemon alike.
 *
 * TWO migrations, not one, because the runner gives each migration its own
 * BEGIN / COMMIT, and DuckDB 1.5.3 cannot commit a DROP INDEX and a CREATE
 * INDEX of a checkpointed index in the same transaction: the COMMIT dies in
 * native code (`libc++abi: Pure virtual function called!`), killing the
 * process that opened the database. Reproduced on a three-row scratch database
 * and on a copy of this repository's own graph; committing the two statements
 * separately succeeds. Between the two commits the table simply has no
 * secondary index, which every reader tolerates (lookups fall back to a scan).
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_067_CG_DROP_EDGE_FILE_TARGET_INDEX = `
DROP INDEX IF EXISTS idx_cg_symbols_edges_file_target;
`;
