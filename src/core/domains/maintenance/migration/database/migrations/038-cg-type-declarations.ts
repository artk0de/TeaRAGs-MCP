/**
 * Type-level declarations for the naming lexicon (bd tea-rags-mcp-vi0wx /
 * l2pkp, spec §1b): one row per type, type alias or file-level constant a
 * walker publishes in `FileExtraction.typeDeclarations`, every language — the
 * single source type roles are derived from at read time.
 *
 * - `type_id` — the composed id, nesting included (`Request.State`);
 *   `short_name` is its last segment, what a role's tail word is read from.
 * - `symbol_kind` — the language-neutral kind (`class`, `interface`, `enum`,
 *   `type_alias`, `constant`, …).
 * - `line` — the 1-based start line a naming finding points at.
 * - `reopens` — `true` for a re-opening (a Swift `extension`); readers of the
 *   project's types filter it out.
 * - `supertypes` — the ancestors the declaration names, in clause order, so a
 *   role read needs no join.
 *
 * No primary key and no secondary index, for the reason migration 033 gives
 * for `cg_identifiers`: rows are replaced per file, and DuckDB vacuums deleted
 * rows at checkpoint only for a table WITHOUT an index (bd tea-rags-mcp-dvzdm).
 *
 * Numbering: 037 is reserved by the cg-cluster branch, so this migration
 * follows 036 here and 037 lands between them when that branch merges.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_038_CG_TYPE_DECLARATIONS = `
CREATE TABLE IF NOT EXISTS cg_type_declarations (
  rel_path     VARCHAR NOT NULL,
  language     VARCHAR NOT NULL,
  type_id      VARCHAR NOT NULL,
  short_name   VARCHAR NOT NULL,
  symbol_kind  VARCHAR,
  line         INTEGER NOT NULL,
  reopens      BOOLEAN NOT NULL,
  supertypes   VARCHAR[] NOT NULL
);
`;
