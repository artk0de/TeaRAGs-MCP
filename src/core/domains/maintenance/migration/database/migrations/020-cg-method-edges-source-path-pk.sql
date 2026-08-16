-- Extend the method-edge primary key with `source_rel_path`
-- (bd tea-rags-mcp-ex28m).
--
-- 001 keyed `cg_symbols_edges_method` on
-- `(source_symbol_id, call_expression, target_symbol_id)`. A `symbolId` is
-- unique per FILE, not per repository — top-level declarations (React function
-- components, a `BaseTable` living in three directories) carry a bare,
-- unqualified id — so two files calling the same target through the same
-- expression produced the SAME key. The write path inserts with `OR IGNORE`, so
-- the second file's edge was dropped on the floor: first file wins, no error at
-- any layer, and the losing file simply has no outgoing edge for that call.
--
-- The read-side file scoping (bd tea-rags-mcp-oxnvl) keys traversal on
-- `(relPath, symbolId)` and still could not see those edges — they were never
-- written. This is the other half of that fix.
--
-- COLUMN ORDER IS LOAD-BEARING. `source_rel_path` goes SECOND, not last:
-- `WHERE source_symbol_id IN (…)` is the frontier-expansion predicate behind
-- `getCalleeEdges` / `getCalleeEdgesScoped`, and it can only use the key as a
-- PREFIX. Appending the new column instead would leave that prefix intact too,
-- but placing it second also keeps `(source_symbol_id, source_rel_path)` — the
-- exact pair the scoped reader matches on — contiguous at the front.
--
-- DuckDB cannot `ALTER TABLE … ADD PRIMARY KEY`, so the table is rebuilt:
-- CREATE new -> INSERT SELECT -> DROP old -> RENAME. Every column carries over,
-- including `edge_kind` / `confidence` from 006 and their legacy NULLs. The
-- INSERT is `OR IGNORE` because the OLD table can itself hold rows that are
-- duplicates under the NEW key only if they were identical anyway — it cannot
-- gain rows, and it must not fail on one.
--
-- This migration is FORWARD-ONLY in effect: rows the old key already discarded
-- are not on disk and cannot be recovered here. Regenerating them needs
-- re-extraction, which is why every language that emits method edges bumps its
-- `codegraphSchema` version alongside this — the language-version drift monitor
-- then tells the operator to run
-- `tea-rags index-codebase --force-enrichments codegraph --languages <langs>`.
--
-- The three secondary indexes are recreated verbatim: 019 measured all three of
-- this table's as earning their drift exposure (a `getCallers`-shape read is
-- 0.24ms indexed against 1.68ms scanned on 1.58M rows, and the per-file DELETE
-- is 1 388ms against 1 684ms), so a rebuild that silently dropped them would
-- undo that measurement. They are NOT carried by the table rename.
--
-- Companion `.ts` is what production loads. Keep in sync.

CREATE TABLE IF NOT EXISTS cg_symbols_edges_method_v2 (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  edge_kind        VARCHAR DEFAULT 'exact',
  confidence       REAL DEFAULT 1.0,
  PRIMARY KEY (source_symbol_id, source_rel_path, call_expression, target_symbol_id)
);

INSERT OR IGNORE INTO cg_symbols_edges_method_v2
  (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
SELECT source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence
  FROM cg_symbols_edges_method;

DROP TABLE cg_symbols_edges_method;

ALTER TABLE cg_symbols_edges_method_v2 RENAME TO cg_symbols_edges_method;

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_source_rel_path
  ON cg_symbols_edges_method (source_rel_path);
