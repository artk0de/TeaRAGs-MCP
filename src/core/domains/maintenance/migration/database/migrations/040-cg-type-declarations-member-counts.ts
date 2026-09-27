/**
 * Codegraph schema — a type declaration's member census on
 * `cg_type_declarations` (bd tea-rags-mcp-ffxfc): how many of the members the
 * declaration writes are methods and how many are fields, the walker's
 * `TypeMemberCensus`.
 *
 * The naming lexicon's per-head kind profile needs to tell a behaviour contract
 * (`CacheStore`: methods) from a data shape (`GitFileSignals`: fields), and
 * `cg_symbols` cannot: it holds no interface member at all and records a Ruby
 * `attr_accessor` as reader and writer methods. The census lives beside the
 * declaration rather than as new `cg_symbols` rows because those rows feed the
 * resolvers' symbol table — a member row there is a call target and a short-name
 * fan-out count, so adding them would move edges.
 *
 * Nullable, no DEFAULT: a row written before the columns has no census, and the
 * read answers "unknown" for it rather than "no members". The walker notes of
 * this release route `--force-enrichments codegraph`, which rewrites the rows
 * with the real counts.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_040_CG_TYPE_DECLARATIONS_MEMBER_COUNTS = `
ALTER TABLE cg_type_declarations ADD COLUMN IF NOT EXISTS method_count INTEGER;
ALTER TABLE cg_type_declarations ADD COLUMN IF NOT EXISTS field_count INTEGER;
`;
