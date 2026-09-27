/**
 * Which types' DESCENDANT sets each file's pass-2 resolution read (bd
 * tea-rags-mcp-7t2ee) — the dependency that lets an incremental run re-resolve
 * an UNCHANGED caller whose CHA cone moved.
 *
 * A cone is a function of the whole hierarchy (`getDescendants(T)`, nominal and
 * `structural` rows alike), while edges are reconciled per SOURCE file. So a
 * caller whose own file did not change kept the cone of the run that last
 * walked it: an implementer added, removed or re-shaped elsewhere never reached
 * it, and full and incremental runs disagreed on the edge set (the owner
 * invariant of bd tea-rags-mcp-39xca.14).
 *
 * - `source_rel_path` — the file whose resolution asked.
 * - `type_name` — the hierarchy key it asked about, as the view keys it.
 * - `descendant_names` — the transitive descendant names the view answered,
 *   sorted, newline-joined. It is both the fingerprint the barrier compares
 *   against the current view and the list a deletion searches for a type the
 *   deleted file declared.
 *
 * Written on the same per-source-file row diff as the edges, keyed by
 * `(source_rel_path, type_name)` so a namesake dependency of another file is
 * its own row (the defect class 027 removed from `cg_ambiguous_fanout`).
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_039_CG_HIERARCHY_DEPENDENCIES = `
CREATE TABLE IF NOT EXISTS cg_hierarchy_dependencies (
  source_rel_path  VARCHAR NOT NULL,
  type_name        VARCHAR NOT NULL,
  descendant_names VARCHAR NOT NULL,
  PRIMARY KEY (source_rel_path, type_name)
);
`;
