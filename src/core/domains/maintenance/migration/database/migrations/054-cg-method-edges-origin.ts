/**
 * Codegraph schema — model-edge provenance on method edges (bd
 * tea-rags-mcp-2m83f, codegraph residual resolution wave 1).
 *
 * `origin` is `'model'` on an edge a residual-pass verdict produced and NULL on
 * every static edge (readers treat NULL as static); `model` and `p` name the
 * provider and its probability; `site_key` ties the edge to its residual row
 * in `cg_residual_call_sites` (053).
 *
 * Nullable, no DEFAULT: every existing row stays a static edge without a
 * rewrite.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_054_CG_METHOD_EDGES_ORIGIN = `
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS origin VARCHAR;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS model VARCHAR;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS p DOUBLE;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS site_key VARCHAR;
`;
