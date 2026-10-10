/**
 * Ruby constant lookup for an instantiation site, returning the fully-qualified
 * name of the class it instantiates (bd tea-rags-mcp-0qaht.65).
 *
 * Ruby resolves an unanchored constant `X` written under `Module.nesting`
 * `[N1, N2, …]` (innermost first) as `N1::X`, then `N2::X`, …, then the
 * top-level `X`; a root-anchored `::X` is the top-level `X` alone. A qualified
 * `A::X` follows the same walk, its first segment found lexically. Ancestor
 * lookup is NOT modelled: an instantiation names a class, and a class reached
 * only through an ancestor's constants is rare enough that the as-written
 * fallback is the honest answer.
 *
 * The walker cannot run this — it sees one file and no symbol table — so it
 * records {@link RubyInstantiationSite}s and the pass-1 barrier calls this with
 * the run's existence oracle. The first DECLARED candidate wins; a site nothing
 * declares stays as written, which keeps an external class (`Faraday::Error`)
 * in the RTA set under its own name.
 *
 * A leaf: contracts-only imports, so the language provider can hand it to the
 * engine without either side importing the walker or the resolver.
 */

import type { RubyInstantiationSite } from "../../../contracts/types/codegraph.js";
import type { InstantiationSiteResolver } from "../../../contracts/types/language.js";

export const resolveRubyInstantiationSite: InstantiationSiteResolver = (
  site: RubyInstantiationSite,
  isDeclared: (typeName: string) => boolean,
): string => {
  if (!site.rootAnchored) {
    for (const level of site.nesting) {
      const candidate = `${level}::${site.name}`;
      if (isDeclared(candidate)) return candidate;
    }
  }
  return site.name;
};
