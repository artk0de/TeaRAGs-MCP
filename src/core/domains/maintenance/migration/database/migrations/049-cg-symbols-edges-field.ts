/**
 * Field-access edges (bd tea-rags-mcp-zy6hx, epic D0): which method reads or
 * writes which field — the data-dependency relation `cg_symbols_edges_method`
 * (calls) and `cg_symbols_edges_file` (imports) cannot express. One row per
 * (method, owner, field, access kind), aggregated at sink time from the
 * `FileExtraction.fieldAccesses` facts a language's facet pass publishes.
 *
 * - `source_rel_path` — the file the accessing method lives in; the per-file
 *   replace and the removed-file delete are scoped by it.
 * - `source_symbol_id` — the accessing method's symbolId (a split method's
 *   `#partN` fragments are attributed to it).
 * - `owner_kind` — `self | class | param | unknown`; `owner_type` — the owning
 *   type's raw NAME as written at sink time (NULL when unknown); `receiver` —
 *   the parameter name for a `param` owner, NULL otherwise.
 * - `field_name` — sigils kept (TS `#x`, Ruby `@x` / `@@x`).
 * - `access_kind` — `read | write | unknown`; a compound assignment is two rows.
 * - `access_count` / `first_line` — how often the method makes this access and
 *   where it first does.
 *
 * No primary key and no secondary index, for the reason migration 033 gives for
 * `cg_identifiers`: rows are replaced per file, and DuckDB vacuums deleted rows
 * at checkpoint only for a table WITHOUT an index (bd tea-rags-mcp-dvzdm).
 * Migrations 018/019 removed indexes that did not earn their keep; one is added
 * here only with a measurement behind it.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_049_CG_SYMBOLS_EDGES_FIELD = `
CREATE TABLE IF NOT EXISTS cg_symbols_edges_field (
  source_rel_path  VARCHAR NOT NULL,
  source_symbol_id VARCHAR NOT NULL,
  owner_kind       VARCHAR NOT NULL,
  owner_type       VARCHAR,
  receiver         VARCHAR,
  field_name       VARCHAR NOT NULL,
  access_kind      VARCHAR NOT NULL,
  access_count     INTEGER NOT NULL,
  first_line       INTEGER
);
`;
