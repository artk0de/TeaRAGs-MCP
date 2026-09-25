/**
 * Codegraph schema — persist the export names each file edge takes from and
 * forwards out of its target (bd tea-rags-mcp-r8hme.2).
 *
 * The leaking-abstraction check decides whether a deep import past a module
 * facade is a bypass (every name it takes, the facade re-exports) or an
 * internal reach (at least one it does not). That comparison needs the names on
 * BOTH edges — the deep importer's and the facade's — so they are stored with
 * the edge rather than recomputed from source at report time.
 *
 * Encoded as comma-joined VARCHAR (names are identifiers, `default` or `*`, so
 * no name contains a comma): the row diff compares value columns by
 * fingerprint, and a scalar keeps that comparison exact. Nullable with no
 * default: a row written before this migration never recorded names, and NULL
 * is what says so — the detector then keeps its file-level rule for that edge.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_030_CG_FILE_EDGE_EXPORT_NAMES = `
ALTER TABLE cg_symbols_edges_file ADD COLUMN IF NOT EXISTS imported_export_names VARCHAR;
ALTER TABLE cg_symbols_edges_file ADD COLUMN IF NOT EXISTS reexported_export_names VARCHAR;
`;
