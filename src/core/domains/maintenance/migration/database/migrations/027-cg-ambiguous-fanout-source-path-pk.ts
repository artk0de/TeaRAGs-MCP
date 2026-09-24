/**
 * Extend the ambiguous fan-out primary key with `source_rel_path`
 * (bd tea-rags-mcp-n9bmd).
 *
 * 013 keyed `cg_ambiguous_fanout` on `(source_symbol_id, call_expression)`. A
 * `symbolId` is unique per FILE, not per repository — a top-level `main`, a
 * Ruby class reopened in two files — so two files whose namesake callers emit
 * the same over-cap fan-out produced the SAME key. The per-file writer
 * (`DuckDbFileGraphStore#writeFileRowsGroup` → `applyScopedRowDiff`) reads the
 * existing rows by `source_rel_path`, cannot see the other file's row, and
 * falls to `INSERT OR IGNORE`: first file wins, the second file's aggregate
 * never exists, and `getAmbiguousCallersByMember` under-reports its callers. No
 * error at any layer. This is the defect class 020 removed from
 * `cg_symbols_edges_method` (bd tea-rags-mcp-ex28m).
 *
 * `source_rel_path` goes SECOND, as in 020: the key keeps `source_symbol_id` as
 * its leading column and the `(source_symbol_id, source_rel_path)` pair — the
 * file-scoped caller identity — contiguous.
 *
 * DuckDB cannot `ALTER TABLE … ADD PRIMARY KEY`, so the table is rebuilt:
 * CREATE new → INSERT OR IGNORE SELECT → DROP old → RENAME. The new key is a
 * strict SUPERSET of the old one, so two rows distinct under 013 are distinct
 * here and the INSERT cannot discard a row at any scale (the reasoning
 * `benchmarks/ex28m-migration-scale-repro.mjs` measured for 020). It is
 * FORWARD-ONLY in effect: aggregates the old key already discarded are not on
 * disk. They return when their file is re-walked, so an unchanged file's lost
 * aggregate needs `--force-enrichments codegraph`.
 *
 * Both secondary indexes 013 created are recreated verbatim — a rename does not
 * carry them. `member` backs `getAmbiguousCallersByMember` and 019 measured it
 * as earning its drift exposure; `source_rel_path` backs the per-file scope
 * read and `removeFile`'s DELETE.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_027_CG_AMBIGUOUS_FANOUT_SOURCE_PATH_PK = `
CREATE TABLE IF NOT EXISTS cg_ambiguous_fanout_v2 (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  member           VARCHAR NOT NULL,
  candidate_count  INTEGER NOT NULL,
  PRIMARY KEY (source_symbol_id, source_rel_path, call_expression)
);

INSERT OR IGNORE INTO cg_ambiguous_fanout_v2
  (source_symbol_id, source_rel_path, call_expression, member, candidate_count)
SELECT source_symbol_id, source_rel_path, call_expression, member, candidate_count
  FROM cg_ambiguous_fanout;

DROP TABLE cg_ambiguous_fanout;

ALTER TABLE cg_ambiguous_fanout_v2 RENAME TO cg_ambiguous_fanout;

CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_source_rel_path
  ON cg_ambiguous_fanout (source_rel_path);

CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_member
  ON cg_ambiguous_fanout (member);
`;
