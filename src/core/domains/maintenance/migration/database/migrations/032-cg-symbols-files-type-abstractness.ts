/**
 * Codegraph schema — persist each file's type-abstractness census on
 * `cg_symbols_files` (bd tea-rags-mcp-r8hme.8).
 *
 * The architecture report's main-sequence detector sums abstract and concrete
 * types per component to read Martin's abstractness A. The census is a walker
 * fact about the file, so it lives on the file row rather than being recomputed
 * from source at report time, which the report — a read over the graph — cannot
 * do.
 *
 * Nullable with no default: a row written before the census existed never
 * measured its types, and NULL is what says so. 0 / 0 is a different fact — the
 * census ran and found no type — and a default would erase the difference.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_032_CG_SYMBOLS_FILES_TYPE_ABSTRACTNESS = `
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS abstract_type_count INTEGER;
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS concrete_type_count INTEGER;
`;
