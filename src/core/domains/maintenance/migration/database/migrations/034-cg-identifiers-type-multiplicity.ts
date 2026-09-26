/**
 * Codegraph schema — the multiplicity of an identifier's declared type on
 * `cg_identifiers` (bd tea-rags-mcp-4p3sb.26).
 *
 * The declaration syntaxes name a collection annotation by its ELEMENT
 * (`candidates: SymbolDefinition[]` → `SymbolDefinition`), so the lexicon
 * groups `candidates` with the element type — on purpose. What that reading
 * dropped is that the name holds MANY of them, which is why the ontology audit
 * listed `candidates` and `fallback` as synonyms for one role.
 * `type_multiplicity` keeps it: `many` for a row whose type was read through a
 * collection, `one` otherwise.
 *
 * DEFAULT 'one': a row written before the column carried no such fact, and
 * reading it as `one` is exactly what every consumer did before. DuckDB fills
 * the default into existing rows but refuses a NOT NULL constraint on an added
 * column, so the writer always writes the value explicitly. The
 * walker bumps of this release route `--force-enrichments codegraph`, which
 * rewrites the rows with the real value.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_034_CG_IDENTIFIERS_TYPE_MULTIPLICITY = `
ALTER TABLE cg_identifiers ADD COLUMN IF NOT EXISTS type_multiplicity VARCHAR DEFAULT 'one';
`;
