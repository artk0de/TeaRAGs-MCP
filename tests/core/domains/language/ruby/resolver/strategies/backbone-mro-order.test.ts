/**
 * The two BACKBONE resolution walkers rank a class's direct ancestors the way
 * Ruby does (bd tea-rags-mcp-mo5ur).
 *
 * `classAncestors` is walker STORAGE order — `[superclass, ...includes]` — which
 * is close to the reverse of Ruby's lookup order: every `include` sits ahead of
 * the superclass, and a later `include` sits ahead of an earlier one. Iterating
 * the stored list therefore hands `super` / `self.<member>` / a typed receiver
 * the superclass's definition when a mixin's definition is the one Ruby reaches.
 *
 * `firstDefinerAfter` and `resolveSuper` already rank via `linearizeAncestors`;
 * these are the two walkers underneath them that still did not. The pins below
 * are ORDER pins: each fixture defines the member on BOTH a mixin and the
 * superclass, so raw order and MRO order give DIFFERENT answers.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  resolveInstanceMethodInClassChain,
  resolveTypeInstanceMethod,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

/** A class whose file declares the class and (optionally) `#m` on it. */
const klassFile = (name: string, definesM: boolean): [string, NamedSymbol[]] => {
  const relPath = `${name.toLowerCase()}.rb`;
  const defs = [sym(name, name, relPath, [])];
  if (definesM) defs.push(sym(`${name}#m`, "m", relPath, [name]));
  return [relPath, defs];
};

describe("resolveInstanceMethodInClassChain — ancestors ranked by MRO, not storage order (mo5ur)", () => {
  it("prefers an INCLUDE over the superclass (class Sub < Base; include M)", () => {
    // Ruby: Sub.ancestors == [Sub, M, Base] → `m` reaches M#m.
    // Walker storage: classAncestors["Sub"] == ["Base", "M"] — superclass first.
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", true), klassFile("M", true));
    const target = resolveInstanceMethodInClassChain(
      "Sub",
      "m",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      new Set(),
    );
    expect(target).toEqual({ targetRelPath: "m.rb", targetSymbolId: "M#m" });
  });

  it("prefers the LAST include over an earlier one (class C; include A; include B)", () => {
    // Ruby: C.ancestors == [C, B, A] — each `include` inserts at the front.
    const symbolTable = tableWith(klassFile("C", false), klassFile("A", true), klassFile("B", true));
    const target = resolveInstanceMethodInClassChain(
      "C",
      "m",
      ctx({ symbolTable, classAncestors: { C: ["A", "B"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      new Set(),
    );
    expect(target).toEqual({ targetRelPath: "b.rb", targetSymbolId: "B#m" });
  });

  it("leaves a RE-INCLUDED module behind the superclass that already carries it", () => {
    // `class Base; include M; end; class Sub < Base; include M; end` — the second
    // `include` is a no-op in Ruby, so Sub.ancestors == [Sub, Base, M] and Base#m
    // wins. Guard against "includes first" being applied as a blanket rule: the
    // ranking has to come from the linearization, which already demoted M.
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", true), klassFile("M", true));
    const target = resolveInstanceMethodInClassChain(
      "Sub",
      "m",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"], Base: ["M"] },
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      new Set(),
    );
    expect(target).toEqual({ targetRelPath: "base.rb", targetSymbolId: "Base#m" });
  });

  it("keeps the class's OWN file as the file-only fallback when nothing defines the member", () => {
    // Membership guard: reordering the ancestor loop must not move which file a
    // file-only edge points at. `Sub` resolves, nothing in the chain defines `m`.
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", false), klassFile("M", false));
    const target = resolveInstanceMethodInClassChain(
      "Sub",
      "m",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      new Set(),
    );
    expect(target).toEqual({ targetRelPath: "sub.rb", targetSymbolId: null });
  });
});

describe("resolveTypeInstanceMethod — ancestors ranked by MRO, not storage order (mo5ur)", () => {
  it("prefers an INCLUDE over the superclass (typed receiver of class Sub < Base; include M)", () => {
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", true), klassFile("M", true));
    const target = resolveTypeInstanceMethod(
      "Sub",
      "m",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(target).toEqual({ targetRelPath: "m.rb", targetSymbolId: "M#m" });
  });

  it("prefers the LAST include over an earlier one (typed receiver of class C; include A; include B)", () => {
    const symbolTable = tableWith(klassFile("C", false), klassFile("A", true), klassFile("B", true));
    const target = resolveTypeInstanceMethod(
      "C",
      "m",
      ctx({ symbolTable, classAncestors: { C: ["A", "B"] } }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(target).toEqual({ targetRelPath: "b.rb", targetSymbolId: "B#m" });
  });

  it("keeps the type's OWN file as the file-only fallback when no ancestor defines the member", () => {
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", false), klassFile("M", false));
    const target = resolveTypeInstanceMethod(
      "Sub",
      "m",
      ctx({
        symbolTable,
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
      }),
      DEFAULT_AMBIGUOUS_RESOLVE_MODE,
    );
    expect(target).toEqual({ targetRelPath: "sub.rb", targetSymbolId: null });
  });
});
