/**
 * Ruby constant lookup for an instantiation site (bd tea-rags-mcp-0qaht.65):
 * each nesting level innermost→outermost `<level>::<name>`, then the top-level
 * `<name>`; a root-anchored `::X` looks at the top level only; the first
 * DECLARED candidate wins, and a site nothing declares stays as written.
 */
import { describe, expect, it } from "vitest";

import type { RubyInstantiationSite } from "../../../../../src/core/contracts/types/codegraph.js";
import { RubyLanguage } from "../../../../../src/core/domains/language/ruby/index.js";
import { resolveRubyInstantiationSite } from "../../../../../src/core/domains/language/ruby/instantiation-site-lookup.js";

const declaredIn =
  (...names: string[]) =>
  (fq: string): boolean =>
    names.includes(fq);

const site = (name: string, nesting: string[], rootAnchored = false): RubyInstantiationSite => ({
  name,
  nesting,
  rootAnchored,
});

describe("resolveRubyInstantiationSite", () => {
  it("mastodon: a constant used inside a class resolves to the real top-level class", () => {
    expect(
      resolveRubyInstantiationSite(
        site("AccountReachFinder", ["SuspendAccountService"]),
        declaredIn("AccountReachFinder", "SuspendAccountService"),
      ),
    ).toBe("AccountReachFinder");
  });

  it("graphql: a written qualifier resolves through the nesting without a doubled prefix", () => {
    expect(
      resolveRubyInstantiationSite(
        site("GraphQL::ExecutionError", ["GraphQL::Schema", "GraphQL"]),
        declaredIn("GraphQL::ExecutionError", "GraphQL::Schema"),
      ),
    ).toBe("GraphQL::ExecutionError");
  });

  it("::Cat inside module Zoo is the top-level Cat even when Zoo::Cat is declared", () => {
    expect(resolveRubyInstantiationSite(site("Cat", ["Zoo"], true), declaredIn("Zoo::Cat", "Cat"))).toBe("Cat");
  });

  it("a nested sibling class is preferred over the top-level namesake", () => {
    expect(
      resolveRubyInstantiationSite(site("Leaf", ["Outer::Inner", "Outer"]), declaredIn("Outer::Leaf", "Leaf")),
    ).toBe("Outer::Leaf");
  });

  it("the innermost declared level wins", () => {
    expect(
      resolveRubyInstantiationSite(
        site("Leaf", ["Outer::Inner", "Outer"]),
        declaredIn("Outer::Inner::Leaf", "Outer::Leaf"),
      ),
    ).toBe("Outer::Inner::Leaf");
  });

  it("a compact `class A::B` nesting reaches A::B::X but not A::X", () => {
    expect(resolveRubyInstantiationSite(site("X", ["A::B"]), declaredIn("A::B::X", "A::X"))).toBe("A::B::X");
    expect(resolveRubyInstantiationSite(site("X", ["A::B"]), declaredIn("A::X"))).toBe("X");
  });

  it("an undeclared site stays as written", () => {
    expect(resolveRubyInstantiationSite(site("Leaf", ["Outer::Inner", "Outer"]), declaredIn())).toBe("Leaf");
    expect(resolveRubyInstantiationSite(site("Ext::Thing", ["Mine"]), declaredIn("Mine"))).toBe("Ext::Thing");
  });

  it("is what the Ruby provider hands the barrier", () => {
    expect(new RubyLanguage().instantiationSiteResolver).toBe(resolveRubyInstantiationSite);
  });
});
