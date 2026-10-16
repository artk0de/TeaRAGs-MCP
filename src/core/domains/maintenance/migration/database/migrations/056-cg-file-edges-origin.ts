/**
 * Codegraph schema — model-derived file edges (bd tea-rags-mcp-2m83f.39).
 *
 * `origin` is `'model'` on a file edge the residual pass derived from a model
 * method edge between two files no import links, and NULL on every edge the
 * walk recorded (readers treat NULL as an import). One column on the existing
 * table, so every file-graph reader — fanIn/fanOut, cycles, layout — sees the
 * dependency without learning a second table.
 *
 * Nullable, no DEFAULT: every existing row stays an import edge without a
 * rewrite.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_056_CG_FILE_EDGES_ORIGIN = `
ALTER TABLE cg_symbols_edges_file ADD COLUMN IF NOT EXISTS origin VARCHAR;
`;
