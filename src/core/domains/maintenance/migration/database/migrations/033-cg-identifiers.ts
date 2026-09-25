/**
 * Identifier declarations for the naming lexicon (bd tea-rags-mcp-4p3sb.8):
 * every param / local / field a symbol declares, plus one `return` row per
 * symbol with a structured return type, each with its best-known type.
 *
 * - `kind` — `param | local | field | return`.
 * - `type_name` / `type_source` — NULL for an untyped declaration; the row is
 *   still recorded, because the value it is bound to can type it at query time.
 * - `bound_member` / `bound_receiver` — the OUTERMOST call a local or field is
 *   bound to; `bound_call_expression` is that call's `CallRef.callText`, the
 *   exact text `cg_symbols_edges_method.call_expression` keys on, so the
 *   lexicon's `call-return` stage is an equi-join rather than a text match.
 *
 * No primary key and no secondary index. Rows are replaced per file and read
 * by GROUP BY, which needs neither (migrations 018/019 dropped the indexes that
 * did not earn their keep), and DuckDB vacuums deleted rows at checkpoint only
 * for a table WITHOUT an index (bd tea-rags-mcp-dvzdm) — so a per-file rewrite
 * of this table leaves no dead row versions behind in the file.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_033_CG_IDENTIFIERS = `
CREATE TABLE IF NOT EXISTS cg_identifiers (
  rel_path              VARCHAR NOT NULL,
  owner_symbol_id       VARCHAR NOT NULL,
  kind                  VARCHAR NOT NULL,
  name                  VARCHAR NOT NULL,
  type_name             VARCHAR,
  type_source           VARCHAR,
  line                  INTEGER NOT NULL,
  bound_member          VARCHAR,
  bound_receiver        VARCHAR,
  bound_call_expression VARCHAR
);
`;
