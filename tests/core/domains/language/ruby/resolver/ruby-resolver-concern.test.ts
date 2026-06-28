/**
 * ActiveSupport::Concern resolution contract (bd tea-rags-mcp-82o24). A class
 * that `include`s a concern reaches the concern's methods through the
 * include-MRO (the module sits in `classAncestors`). `collectSymbols` already
 * collects methods defined inside `included do ... end` / `class_methods do`
 * under the module's scope; `rbNameOf` tags the `class_methods` block defs
 * STATIC so a `C.classmethod` call on the includer resolves to the module
 * definition instead of a file-only edge.
 *
 * This pins the END-TO-END resolution given the symbol forms `collectSymbols`
 * now produces (instance `Module#m` for `included do`; static `Module.m` for
 * `class_methods do`).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const MOD = "app/models/concerns/trackable.rb";
const A = "app/models/a.rb";
const resolver = new RubyCallResolver(DEFAULT_AMBIGUOUS_RESOLVE_MODE);

function table(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile(MOD, [
    sym("Trackable", "Trackable", MOD, []),
    // `included do; def track; end` → instance form under the module.
    sym("Trackable#track", "track", MOD, ["Trackable"]),
    // `class_methods do; def find_tracked; end` → STATIC form (rbNameOf tag).
    sym("Trackable.find_tracked", "find_tracked", MOD, ["Trackable"]),
  ]);
  t.upsertFile(A, [sym("A", "A", A, [])]);
  return t;
}

const ctx = (over: Partial<CallContext>): CallContext => ({
  callerFile: A,
  callerScope: ["A"],
  imports: [],
  symbolTable: table(),
  classAncestors: { A: ["Trackable"] }, // include Trackable
  ...over,
});

describe("RubyCallResolver — ActiveSupport::Concern method resolution", () => {
  it("instance method from `included do` resolves to the module definition", () => {
    const call: CallRef = { callText: "track", receiver: null, member: "track", startLine: 5 };
    expect(resolver.resolve(call, ctx({}))?.targetSymbolId).toBe("Trackable#track");
  });

  it("class method from `class_methods do`, called bare inside the includer, resolves to the module definition", () => {
    const call: CallRef = { callText: "find_tracked", receiver: null, member: "find_tracked", startLine: 5 };
    expect(resolver.resolve(call, ctx({}))?.targetSymbolId).toBe("Trackable.find_tracked");
  });

  it("class method `A.find_tracked` called from outside resolves to the module definition", () => {
    const call: CallRef = { callText: "A.find_tracked", receiver: "A", member: "find_tracked", startLine: 5 };
    expect(resolver.resolve(call, ctx({ callerScope: ["Other"] }))?.targetSymbolId).toBe("Trackable.find_tracked");
  });
});
