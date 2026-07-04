-- Codegraph method-edge source_rel_path index (bd tea-rags-mcp-f2jsb).
--
-- upsertFileImpl deletes a file's method edges by source_rel_path on every
-- re-walk (`DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ?`);
-- without this index each delete scans the WHOLE edge table — 24k files x
-- 1.5M rows on taxdome-class corpora added up to hours of WAL writes at an
-- effective ~97 rows/sec. 001 already indexes target_symbol_id and
-- target_rel_path; the source side of the per-file lifecycle was the gap.
CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_source_rel_path
  ON cg_symbols_edges_method (source_rel_path);
