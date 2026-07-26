/**
 * Symbol-name helpers shared by the codegraph provider and its collaborators.
 *
 * Lives in its own module so neither side imports the other for a string
 * utility (bd tea-rags-mcp-6vfrj / G2): `provider.ts` needs it to build
 * `SymbolDefinition.shortName`, `resolution-runner.ts` needs it to synthesise
 * import lookups.
 */

export function lastSegment(name: string): string {
  // Four callers with different separator conventions:
  //  - symbolIds like "Foo#bar" (instance) split on "#" → "bar"
  //  - symbolIds like "Foo.bar" (static / nested namespace) split on "." → "bar"
  //  - import paths like "../core/api/index.js" split on "/" → "index.js"
  //  - overload-disambiguated ids like "Foo.bar~2" (bd a466) — the
  //    `~N` suffix MUST be stripped before the last-segment cut so
  //    `lookupByShortName("bar")` matches every overload. Without the
  //    strip the short name would carry the suffix
  //    (`bar~2`) and shortName lookup would miss.
  // Path lookups must NOT split on "." or we'd return the extension
  // ("js") instead of the basename. Order is: "/" wins (path detection),
  // then "#" (instance method short-name), then "." (static / namespace
  // last component); finally strip any trailing `~N` arity suffix.
  const slash = name.lastIndexOf("/");
  if (slash !== -1) return name.slice(slash + 1);
  const hash = name.lastIndexOf("#");
  const segment =
    hash !== -1
      ? name.slice(hash + 1)
      : (() => {
          const dot = name.lastIndexOf(".");
          return dot === -1 ? name : name.slice(dot + 1);
        })();
  return segment.replace(/~\d+$/, "");
}
