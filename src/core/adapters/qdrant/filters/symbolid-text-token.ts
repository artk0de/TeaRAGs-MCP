/**
 * A symbolId reduced to the ONE token the Qdrant `symbolId` text index can be
 * relied on to hold for that row (bd tea-rags-mcp-yx10, lifted here by
 * tea-rags-mcp-ivp12).
 *
 * `glob.ts`'s counterpart for the other text-indexed key: both turn a query
 * into terms the `word` tokenizer actually stored, which is why both are
 * adapter knowledge rather than a caller's business.
 *
 * The field is indexed as `text` with the default `word` tokenizer, which
 * splits on every non-alphanumeric character: `Foo::Bar#baz=` is stored as
 * `[foo, bar, baz]`. Passing a whole fully-qualified name to `match: { text }`
 * ANDs those tokens together, and under some live index states that conjunction
 * returns nothing for a row that IS present. The last name segment is a single
 * token, always among the row's own, so it is the query that hits.
 *
 * Two consumers, in two layers, and they must agree:
 *
 *   1. `domains/explore/strategies/symbol.ts` builds the `find_symbol` scroll
 *      filter from it, then post-filters the tokenized superset it returns.
 *   2. `scroller.ts#scrollBySymbolIds` pairs it with the exact `match: { value }`
 *      condition (`./text-indexed-exact.ts`), so the scroll is served by the
 *      text index instead of scanning the collection once per id.
 *
 * Domains may import adapters, so one copy serves both. (The AST-level half of
 * the symbolId convention lives in `infra/symbolid/` — that module answers what
 * an id IS, this one answers how Qdrant stored it.)
 *
 * A token that is too LOOSE costs candidates, never correctness — where it is
 * paired, the `value` condition decides membership. A token the row does not
 * carry costs the row itself, which is the failure this module prevents.
 */

/**
 * Structural separators between a container and its member in a symbolId.
 * `#` = instance method, `.` = static method / namespace member, `::` =
 * namespace. See `.claude/rules/symbolid-convention.md`.
 */
export const SYMBOL_SEPARATORS = /[#.]|::/;

/**
 * Suffix characters that mark Ruby setter / predicate / bang methods and are
 * always token separators under Qdrant's `word` tokenizer.
 */
const METHOD_NAME_SUFFIX = /[=?!]+$/;

/**
 * Last name segment of a symbolId, suffixes intact.
 *
 *   `Foo::Bar#baz`   → `baz`
 *   `Foo#updated=`   → `updated=`
 *   `Foo#valid?`     → `valid?`
 *   `app.set`        → `set`
 *   `set` (bare)     → `set`
 *
 * The COMPARISON form, not the query form: `updated=` and `updated` are
 * different methods and must stay distinguishable.
 */
export function symbolIdLastSegment(symbol: string): string {
  return symbol.split(SYMBOL_SEPARATORS).pop() ?? symbol;
}

/**
 * The single text token to query the `symbolId` index with.
 *
 *   `Foo::Bar#baz`       → `baz`
 *   `Foo.bar`            → `bar`
 *   `Foo#updated=`       → `updated`  (the `=` is stripped at token boundary)
 *   `Foo#valid?`         → `valid`
 *   `Foo#save!`          → `save`
 *   `createNote` (bare)  → `createNote`
 *
 * Bare names — no separator and no method-name suffix — come back unchanged, so
 * the existing short-name behaviour is untouched.
 */
export function symbolIdTextToken(symbol: string): string {
  return symbolIdLastSegment(symbol).replace(METHOD_NAME_SUFFIX, "");
}
