/**
 * Codegraph schema — the importer-facing side of an aliased re-export on
 * `cg_symbols_edges_file` (bd tea-rags-mcp-zl3so).
 *
 * `reexported_export_names` (migration 030) holds the TARGET's spelling, so
 * `export { a as b } from "./x"` recorded `a` and a facade surface read off it
 * still "exposed" `a` after a rename broke every importer of `a`. This column
 * holds the exposed → forwarded table, encoded `b:a,c:c` (names are
 * identifiers, `default` or `*`, so none contains `:` or `,`).
 *
 * Nullable with no default: NULL means no statement of the edge renamed — the
 * exposed names ARE the source names — which is also exactly what a row
 * written before this migration must read as. The walker notes of this release
 * route `--force-enrichments codegraph`, which records the tables.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_051_CG_FILE_EDGE_REEXPORT_BINDINGS = `
ALTER TABLE cg_symbols_edges_file ADD COLUMN IF NOT EXISTS reexported_export_bindings VARCHAR;
`;
