/**
 * The constant → FILE half of the Ruby same-language rule (bd
 * tea-rags-mcp-zn4uf). kumq2 routed every SHORT-NAME lookup through
 * `lookupRubySymbolsByShortName`, but `resolveConstant` still reached its file
 * through the language-blind `symbolTable.lookup(fq)`, so the pick site it
 * feeds kept two cross-language holes:
 *
 *   - A `.tsx` class that merely spells the constant ANSWERS the lookup, and
 *     the constant strategy commits a file-only edge into it — the mastodon
 *     `--polyglot` symptom, `targetSymbolId null / targetRelPath <x>.tsx`.
 *   - With a Ruby declaration AND a JS namesake both present the direct pass
 *     sees cardinality 2, declines, and SUPPRESSES the valid Ruby answer.
 *
 * A Ruby-only table must behave exactly as before — the filter removes
 * non-Ruby paths and nothing else.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyConstantSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { resolveConstant } from "../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

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
  callerFile: "app/serializers/report_serializer.rb",
  callerScope: [],
  imports: [],
  ...over,
});

const TSX = "app/javascript/Foo.tsx";
const RB = "app/models/foo.rb";

const tsxFoo = (): [string, NamedSymbol[]] => [TSX, [sym("Foo", "Foo", TSX, []), sym("Foo.bar", "bar", TSX, ["Foo"])]];
const rbFoo = (): [string, NamedSymbol[]] => [RB, [sym("Foo", "Foo", RB, []), sym("Foo.bar", "bar", RB, ["Foo"])]];

const fooBar: CallRef = { callText: "Foo.bar(x)", receiver: "Foo", member: "bar", startLine: 1 };

describe("resolveConstant — same-language files only", () => {
  it("does not answer with a `.tsx` file when only the JS side declares the constant", () => {
    expect(resolveConstant("Foo", ctx({ symbolTable: tableWith(tsxFoo()) }))).toBeNull();
  });

  it("picks the Ruby declaration when a JS namesake sits beside it", () => {
    expect(resolveConstant("Foo", ctx({ symbolTable: tableWith(tsxFoo(), rbFoo()) }))).toBe(RB);
  });

  it("keeps the enclosing-scope pass same-language too", () => {
    const nested = "app/javascript/admin/Foo.tsx";
    const symbolTable = tableWith([nested, [sym("Admin::Foo", "Foo", nested, ["Admin"])]]);
    expect(resolveConstant("Foo", ctx({ symbolTable, callerScope: ["Admin"] }))).toBeNull();
  });

  it("is a no-op on a Ruby-only table (unchanged)", () => {
    expect(resolveConstant("Foo", ctx({ symbolTable: tableWith(rbFoo()) }))).toBe(RB);
  });
});

describe("constant strategy — never emits a cross-language file-only edge", () => {
  it("yields no `.tsx` target and no `.tsx` file for a JS-only namesake", () => {
    const outcome = new RubyConstantSymbolResolutionStrategy(cfg).attempt(
      fooBar,
      ctx({ symbolTable: tableWith(tsxFoo()) }),
    );
    const target = outcome.kind === "resolved" || outcome.kind === "deferred" ? outcome.target : null;
    expect(target?.targetSymbolId ?? null).toBeNull();
    expect(target?.targetRelPath ?? null).toBeNull();
  });

  it("pins the Ruby class method when a JS namesake sits beside it", () => {
    const outcome = new RubyConstantSymbolResolutionStrategy(cfg).attempt(
      fooBar,
      ctx({ symbolTable: tableWith(tsxFoo(), rbFoo()) }),
    );
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: RB,
      targetSymbolId: "Foo.bar",
    });
  });

  it("pins the Ruby class method on a Ruby-only table (unchanged)", () => {
    const outcome = new RubyConstantSymbolResolutionStrategy(cfg).attempt(
      fooBar,
      ctx({ symbolTable: tableWith(rbFoo()) }),
    );
    expect(outcome.kind === "resolved" ? outcome.target : null).toEqual({
      targetRelPath: RB,
      targetSymbolId: "Foo.bar",
    });
  });
});
