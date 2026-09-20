/**
 * Reading a composed symbolId as "this declares a TYPE" — the one question the
 * Swift resolver has to answer that no walker channel answers for it.
 *
 * `NamedSymbol.descendsInto` is the container/leaf flag a walker DOES set, but
 * it is explicitly descriptive: `collectSymbols` drops it, so it reaches
 * neither `ChunkExtraction` nor `SymbolDefinition`, and a definition arrives at
 * the resolver with no marker saying whether it is a type or a method.
 * Propagating the flag is a kernel + contract change touching all nine
 * languages; these two predicates get Swift the same answer from what a
 * definition already carries.
 *
 * Two pieces of evidence, in order of strength:
 *
 *   1. **The composed separator, which is proof.** `.claude/rules/symbolid-convention.md`
 *      gives an instance member `#` and everything else the language's scope
 *      separator. A `#`-form id is therefore a method, whatever it is named,
 *      and no type is ever reachable through one.
 *   2. **UpperCamelCase, which is convention.** The remaining forms — a bare
 *      top-level id, and a `.`-joined one — are a type OR a free function
 *      (`Invoice` vs `formatDecimal`) and a nested type OR a static member
 *      (`Ledger.Account` vs `Invoice.empty`). Swift's API Design Guidelines
 *      settle it: "names of types and protocols are UpperCamelCase, all other
 *      names are lowerCamelCase". This vertical already spends that convention
 *      as typing evidence — the walker binds `var tmp = Helper()` only when the
 *      callee is CapWords, mirroring Rust's `isCapWordsType` and Python's
 *      `isCapWordsConstructor` — so reading it here adds no new class of
 *      assumption.
 *
 * What it costs when a corpus violates the guideline: a CapWords free function
 * overloaded in one file reads as a re-opened type and its namesakes collapse
 * to the first. The opposite error — a lowerCamelCase type — reads as a method
 * and simply keeps today's behaviour. Both are bounded, and only the first is a
 * wrong answer rather than a missing one.
 */

/**
 * The suffix `collectSymbols` appends to the 2nd and later declaration of one
 * composed id under `disambiguateOverloads` (1-based, so the second is `~2` and
 * the first keeps the bare id).
 */
const OVERLOAD_SUFFIX = /~\d+$/;

/** Separators a composed symbolId can end a qualified prefix with. */
const ID_SEPARATORS = [".", "#"] as const;

/** Whether this id is a 2nd-or-later declaration of an id already composed in its file. */
export function hasSwiftOverloadSuffix(symbolId: string): boolean {
  return OVERLOAD_SUFFIX.test(symbolId);
}

/** The id this one disambiguates from: `Invoice~2` → `Invoice`. Identity for an unsuffixed id. */
export function stripSwiftOverloadSuffix(symbolId: string): string {
  return symbolId.replace(OVERLOAD_SUFFIX, "");
}

/**
 * Swift's UpperCamelCase gate — the name of a type or protocol, as opposed to
 * every other name in the language.
 */
export function isSwiftTypeName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * Whether a composed symbolId names a TYPE declaration rather than a member:
 * the final segment is UpperCamelCase AND is not reached through `#`.
 *
 * Both conditions do work. The `#` test alone would admit `Invoice.empty`
 * (a static member); the name test alone would admit a hypothetical
 * `Invoice#Render`. Overload suffixes are stripped first, so `Invoice~2` is
 * judged as the `Invoice` it re-declares.
 */
export function isSwiftTypeDeclarationId(symbolId: string): boolean {
  const base = stripSwiftOverloadSuffix(symbolId);
  const cut = Math.max(...ID_SEPARATORS.map((separator) => base.lastIndexOf(separator)));
  if (base[cut] === "#") return false;
  return isSwiftTypeName(base.slice(cut + 1));
}
