/**
 * Re-key `cg_symbols_edges_method` WITHOUT `target_symbol_id` in the primary
 * key (bd tea-rags-mcp-rtp6v).
 *
 * 001/020 keyed the table on
 * `(source_symbol_id, source_rel_path, call_expression, target_symbol_id)`,
 * and DuckDB forces every PK column NOT NULL — even though the column is
 * DECLARED nullable and the `GraphEdges` contract types `targetSymbolId` as
 * `SymbolId | null`. A method edge whose target the resolver could not pin —
 * the file-only edge: the checker proved the FILE but no exported symbol table
 * names the member (the `fetcher.request()` family the merged 05uhs checker
 * widening deliberately produces) — was uninsertable, and
 * `DuckDbFileGraphStore#writeFileRowsGroup` skipped it silently. A file-only
 * edge was NO edge, dropped at write time with no error at any layer.
 *
 * The key becomes the CALL SITE:
 * `(source_symbol_id, source_rel_path, call_expression, target_rel_path)`,
 * carried by a fifth NOT NULL member, `target_symbol_key` — the PK-safe
 * sentinel form of `target_symbol_id` (`COALESCE(target_symbol_id, '')`).
 * `target_symbol_id` itself stays a plain nullable VARCHAR column, so the
 * file-only row persists with the target_rel_path the resolver did resolve.
 *
 * WHY THE FIFTH COLUMN — the one deviation from the decided 4-tuple, taken on
 * evidence. A 4-column key collides every DISPATCH/INTERFACE FAN-OUT whose
 * candidates live in one file: `LANGUAGES[ext].walker(input)` fanning to
 * `extractTs` AND `extractRb` in the same `walkers.ts` (bd tea-rags-mcp-n0zj),
 * or `totalArea(shape)` fanning to two implementers in one `shapes.ts` (bd
 * tea-rags-mcp-t5cji), emits m edges sharing (source, source_rel_path,
 * call_expression, target_rel_path) — under a 4-column key only the first
 * candidate survives, and every other candidate's fan-in silently drops to
 * zero. That is the exact silent-drop defect class this migration exists to
 * remove, reintroduced one column over. The sentinel keeps the candidates
 * distinct while remaining constant for an identical re-upsert, so the dedup
 * semantics the decision pinned are unchanged: the same edge upserted twice
 * still lands once.
 *
 * The `(source_symbol_id, source_rel_path)` prefix — the frontier-expansion
 * predicate behind `getCalleeEdges` / `getCalleeEdgesScoped` — remains
 * contiguous at the front, exactly as 020 arranged it.
 *
 * The rebuild follows 020's pattern: CREATE new → INSERT OR IGNORE SELECT →
 * DROP old → RENAME. The INSERT is `OR IGNORE` and the sentinel is computed
 * in the SELECT, because the OLD table can hold rows that are duplicates under
 * the NEW key — two pins of one call site to one file with DIFFERENT null
 * spellings cannot occur, but a pinned row and nothing else is identical to
 * itself; `OR IGNORE` cannot gain rows and must not fail on one. Rows the old
 * writer never persisted (the file-only edges) are not on disk and cannot be
 * recovered here — FORWARD-ONLY in effect, like 020; regenerating them needs
 * re-extraction (`--force-enrichments codegraph`).
 *
 * The three secondary indexes are recreated verbatim — 019 measured all three
 * as earning their drift exposure, and they are NOT carried by the rename.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_026_CG_METHOD_EDGES_NULLABLE_TARGET = `
CREATE TABLE IF NOT EXISTS cg_symbols_edges_method_v2 (
  source_symbol_id  VARCHAR NOT NULL,
  source_rel_path   VARCHAR NOT NULL,
  target_rel_path   VARCHAR NOT NULL,
  call_expression   VARCHAR NOT NULL,
  target_symbol_key VARCHAR NOT NULL,
  target_symbol_id  VARCHAR,
  edge_kind         VARCHAR DEFAULT 'exact',
  confidence        REAL DEFAULT 1.0,
  PRIMARY KEY (source_symbol_id, source_rel_path, call_expression, target_rel_path, target_symbol_key)
);

INSERT OR IGNORE INTO cg_symbols_edges_method_v2
  (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key, target_symbol_id, edge_kind, confidence)
SELECT source_symbol_id, source_rel_path, target_rel_path, call_expression, COALESCE(target_symbol_id, ''), target_symbol_id, edge_kind, confidence
  FROM cg_symbols_edges_method;

DROP TABLE cg_symbols_edges_method;

ALTER TABLE cg_symbols_edges_method_v2 RENAME TO cg_symbols_edges_method;

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_source_rel_path
  ON cg_symbols_edges_method (source_rel_path);
`;
