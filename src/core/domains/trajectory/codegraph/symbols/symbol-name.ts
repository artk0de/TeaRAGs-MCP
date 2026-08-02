/**
 * Symbol-name helpers shared by the codegraph provider and its collaborators.
 *
 * Lives in its own module so neither side imports the other for a string
 * utility (bd tea-rags-mcp-6vfrj / G2): `provider.ts` needs it to build
 * `SymbolDefinition.shortName`, `resolution-runner.ts` needs it to synthesise
 * import lookups.
 */

/**
 * Separators that end a qualified name, longest form first so `::` is never
 * mistaken for two `.`-less segments. `/` is NOT here — it is a path separator
 * and wins outright (see below).
 */
const NAME_SEPARATORS = ["::", "#", "."] as const;

export function lastSegment(name: string): string {
  // Callers with different separator conventions:
  //  - symbolIds like "Foo#bar" (instance) split on "#" → "bar"
  //  - symbolIds like "Foo.bar" (static / nested namespace) split on "." → "bar"
  //  - symbolIds like "GettingPaid::Bill" (Ruby/Rust compact-FQ declaration)
  //    split on "::" → "Bill" (bd tea-rags-mcp-jii03). Without this, a
  //    compact-form class is indexed under the short name "GettingPaid::Bill"
  //    and `lookupByShortName("Bill")` answers ZERO — which blinds every
  //    short-name channel on a namespaced-model codebase.
  //  - import paths like "../core/api/index.js" split on "/" → "index.js"
  //  - overload-disambiguated ids like "Foo.bar~2" (bd a466) — the
  //    `~N` suffix MUST be stripped before the last-segment cut so
  //    `lookupByShortName("bar")` matches every overload. Without the
  //    strip the short name would carry the suffix
  //    (`bar~2`) and shortName lookup would miss.
  // Path lookups must NOT split on "." or we'd return the extension
  // ("js") instead of the basename, so "/" wins outright (path detection).
  // Among the name separators the RIGHTMOST one cuts, so "A::B#save" yields
  // "save" and "A::B" yields "B"; finally strip any trailing `~N` arity suffix.
  const slash = name.lastIndexOf("/");
  if (slash !== -1) return name.slice(slash + 1);
  let cut = 0;
  for (const separator of NAME_SEPARATORS) {
    const at = name.lastIndexOf(separator);
    if (at !== -1 && at + separator.length > cut) cut = at + separator.length;
  }
  return name.slice(cut).replace(/~\d+$/, "");
}
