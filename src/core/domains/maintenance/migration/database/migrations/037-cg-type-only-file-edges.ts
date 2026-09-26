/**
 * Type-only file dependencies (bd tea-rags-mcp-r8hme.12): one row per
 * (source, target) file pair the source reaches ONLY through imports that bring
 * in types and load nothing at runtime — TypeScript's `import type` /
 * `export type … from`.
 *
 * A table of its own, not a flag on `cg_symbols_edges_file`: every reader of
 * that table (fanIn / fanOut, PageRank, cycles, transitive impact, SDP) measures
 * RUNTIME dependencies, and a flag would have to be filtered out by each of
 * them, forever. Here the runtime file graph cannot see these rows by
 * construction; the one reader is the silent-coupling linkage
 * (`DuckDbTemporalCochangeStore#readGraph`), for which a declared type
 * dependency is structure all the same.
 *
 * Same key and lifecycle as `cg_symbols_edges_file` — replaced per source file
 * by the scoped row diff, deleted as source OR target with the file. No
 * secondary index: the only read joins the whole table once per report.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_037_CG_TYPE_ONLY_FILE_EDGES = `
CREATE TABLE IF NOT EXISTS cg_symbols_edges_file_type_only (
  source_rel_path  VARCHAR NOT NULL,
  target_rel_path  VARCHAR NOT NULL,
  import_text      VARCHAR,
  PRIMARY KEY (source_rel_path, target_rel_path)
);
`;
