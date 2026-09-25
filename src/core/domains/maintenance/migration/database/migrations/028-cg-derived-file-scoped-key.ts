/**
 * Key the derived codegraph tables by the declaring FILE as well as the symbol
 * (bd tea-rags-mcp-4g9ga).
 *
 * 004 keyed `cg_symbols_metrics` on `symbol_id` alone, and 003 stored a
 * method-scope `cg_symbols_cycles` member as a bare symbol id. A `SymbolId` is
 * unique per FILE, not per repository, so the PageRank graph and the Tarjan
 * graph both merged every namesake into ONE vertex: every top-level `main`
 * shared one rank, and two Go `init()` functions in different files of a
 * package (bd tea-rags-mcp-4400) glued two unrelated cycles into one SCC. Same
 * defect class as 020 (ex28m) — one string, two meanings.
 *
 * `cg_symbols_cycles` gains `member_rel_path`: the member's own file. For the
 * file scope a member IS a path, so the column repeats it; for the method scope
 * it is the file declaring the symbol. It joins the key, because two namesakes
 * CAN sit in one cycle. `cg_symbols_metrics` gains `rel_path` and is keyed
 * `(rel_path, symbol_id)`.
 *
 * DuckDB cannot `ALTER TABLE … ADD PRIMARY KEY`, so both tables are rebuilt:
 * CREATE new → INSERT SELECT → DROP old → RENAME. Both are wholesale
 * recomputes, so carrying rows over only bridges the gap until the next
 * finalize rewrites them. A carried method-scope member and a carried rank have
 * no file to name, so they get `''` — the same "unknown file" spelling
 * `parseFileScopedSymbolKey` uses. Readers treat a `''` rank as the pre-028
 * merged value and fan it out to every namesake, which is exactly what they
 * served before, so the migration alone moves no payload value. A carried
 * `''` method member matches no `find_cycles` pathPattern until that finalize.
 *
 * No secondary index is recreated: 018 dropped `cg_symbols_cycles`' two (ART
 * drift broke the per-scope DELETE) and 019 dropped the `page_rank` one
 * (written and read whole, never filtered). The rename carries none either.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_028_CG_DERIVED_FILE_SCOPED_KEY = `
CREATE TABLE IF NOT EXISTS cg_symbols_cycles_v2 (
  cycle_id         INTEGER NOT NULL,
  scope            VARCHAR NOT NULL,
  member_rel_path  VARCHAR NOT NULL,
  member           VARCHAR NOT NULL,
  position         INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, scope, member_rel_path, member)
);

INSERT OR IGNORE INTO cg_symbols_cycles_v2 (cycle_id, scope, member_rel_path, member, position)
SELECT cycle_id, scope, CASE WHEN scope = 'file' THEN member ELSE '' END, member, position
  FROM cg_symbols_cycles;

DROP TABLE cg_symbols_cycles;

ALTER TABLE cg_symbols_cycles_v2 RENAME TO cg_symbols_cycles;

CREATE TABLE IF NOT EXISTS cg_symbols_metrics_v2 (
  rel_path   VARCHAR NOT NULL,
  symbol_id  VARCHAR NOT NULL,
  page_rank  DOUBLE NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);

INSERT OR IGNORE INTO cg_symbols_metrics_v2 (rel_path, symbol_id, page_rank)
SELECT '', symbol_id, page_rank
  FROM cg_symbols_metrics;

DROP TABLE cg_symbols_metrics;

ALTER TABLE cg_symbols_metrics_v2 RENAME TO cg_symbols_metrics;
`;
