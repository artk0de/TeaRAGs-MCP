/**
 * Codegraph schema — a class declaration's async instance methods on
 * `cg_type_declarations` (bd tea-rags-mcp-ek2cu), the walker's
 * `TypeMemberCensus.asyncMethodCount`.
 *
 * The naming lexicon's directory families need a BEHAVIOUR fact the member
 * census cannot give: `api/internal/ops/` holds `*Ops` facades, every method
 * async, beside computational models (`MaintenanceCostShrinkage`) with the same
 * method and field counts and no async method at all.
 *
 * Nullable, no DEFAULT: a row written before the column, an interface, and a
 * language whose census takes no async count all read "unknown", and unknown
 * never excludes a type from a family. The walker notes of this release route
 * `--force-enrichments codegraph`, which rewrites the rows with the counts.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_050_CG_TYPE_DECLARATIONS_ASYNC_METHOD_COUNT = `
ALTER TABLE cg_type_declarations ADD COLUMN IF NOT EXISTS async_method_count INTEGER;
`;
