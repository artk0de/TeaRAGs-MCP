/**
 * Codegraph schema — shared class sets of residual receiver groups (bd
 * tea-rags-mcp-2m83f.52, residual wave 1.5).
 *
 * A receiver group over 40 classes repeats the same few class sets on
 * thousands of rows (TaxDome: 6,105 rows, 150 distinct (member, set) pairs, 201
 * MB inline). `cg_residual_class_sets` holds each encoded set once under
 * `set_key` (sha1 of member and encoded set); `cg_residual_call_sites.class_set`
 * names it, and such a row leaves `class_targets` NULL. A set of 40 classes or
 * fewer stays inline. NULL `class_set` on every row written before 063: it reads
 * its `class_targets` as before. A set no row names any more is deleted by the
 * next write group that stores a set, or by a file removal.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_063_CG_RESIDUAL_CLASS_SETS = `
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS class_set VARCHAR;
CREATE TABLE IF NOT EXISTS cg_residual_class_sets (
  set_key       VARCHAR NOT NULL PRIMARY KEY,
  class_targets VARCHAR NOT NULL
);
`;
