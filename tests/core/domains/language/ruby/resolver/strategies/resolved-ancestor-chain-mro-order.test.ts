/**
 * `collectResolvedAncestorChain` hands its consumers Ruby's ancestor order, not
 * walker storage order (bd tea-rags-mcp-ymht3, the mo5ur remainder).
 *
 * Both consumers take the FIRST hop that answers — `bareCall` returns the first
 * unique scope-tier match, `schemaColumn` the first unique column match — so the
 * order the collector emits IS the precedence rule. `classAncestors` stores
 * `[superclass, ...includes]`, close to the reverse of what Ruby reaches: every
 * `include` sits ahead of the superclass, and a later `include` ahead of an
 * earlier one.
 *
 * The pins below are ORDER pins: each fixture puts the member on BOTH a mixin
 * and the superclass, so storage order and MRO order name DIFFERENT winners.
 * The guards alongside them pin MEMBERSHIP — reordering the walk must not change
 * WHICH ancestors are reachable, only which is reached first.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
  type SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyBareCallSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { RubySchemaColumnSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-schema-column.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

const bareCall = (member: string): CallRef => ({ callText: member, receiver: null, member, startLine: 1 });

/** A class whose file declares the class and (optionally) `#m` on it. */
const klassFile = (name: string, definesM: boolean): [string, NamedSymbol[]] => {
  const relPath = `${name.toLowerCase()}.rb`;
  const defs = [sym(name, name, relPath, [])];
  if (definesM) defs.push(sym(`${name}#m`, "m", relPath, [name]));
  return [relPath, defs];
};

describe("bareCall MRO narrowing — ancestors ranked by MRO, not storage order (ymht3)", () => {
  const strat = new RubyBareCallSymbolResolutionStrategy(cfg);

  it("prefers an INCLUDE over the superclass (class Sub < Base; include M)", () => {
    // Ruby: Sub.ancestors == [Sub, M, Base] → an ambiguous `m` narrows to M#m.
    // Walker storage: classAncestors["Sub"] == ["Base", "M"] — superclass first.
    // Both defs share the short name, so the narrowing walk is what decides.
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", true), klassFile("M", true));
    const outcome = strat.attempt(
      bareCall("m"),
      ctx({
        symbolTable,
        callerScope: ["Sub"],
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
      }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "m.rb", targetSymbolId: "M#m" } });
  });

  it("prefers the LAST include over an earlier one (class C; include A; include B)", () => {
    // Ruby: C.ancestors == [C, B, A] — each `include` inserts at the front.
    const symbolTable = tableWith(klassFile("C", false), klassFile("A", true), klassFile("B", true));
    const outcome = strat.attempt(
      bareCall("m"),
      ctx({ symbolTable, callerScope: ["C"], classAncestors: { C: ["A", "B"] } }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "b.rb", targetSymbolId: "B#m" } });
  });

  it("leaves a RE-INCLUDED module behind the superclass that already carries it", () => {
    // `class Base; include M; end; class Sub < Base; include M; end` — the second
    // `include` is a no-op in Ruby, so Sub.ancestors == [Sub, Base, M] and Base#m
    // wins. Guard against "includes first" being applied as a blanket rule: the
    // ranking has to come from the linearization, which already demoted M.
    const symbolTable = tableWith(klassFile("Sub", false), klassFile("Base", true), klassFile("M", true));
    const outcome = strat.attempt(
      bareCall("m"),
      ctx({
        symbolTable,
        callerScope: ["Sub"],
        classAncestors: { Sub: ["Base", "M"], Base: ["M"] },
        classExtends: { Sub: "Base" },
      }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "base.rb", targetSymbolId: "Base#m" } });
  });

  it("still reaches a TRANSITIVE ancestor that only the far end of the chain defines", () => {
    // Membership guard: `Sub < Base`, `Base < Root`, `include M`; only Root owns
    // `m`. Reordering the direct ancestors must not prune the deeper hop — the
    // reachable closure is the same set, walked in a different order.
    const symbolTable = tableWith(
      klassFile("Sub", false),
      klassFile("Base", false),
      klassFile("Root", true),
      klassFile("M", false),
      // Unrelated namesake keeps the short-name lookup ambiguous.
      ["widget.rb", [sym("Widget#m", "m", "widget.rb", ["Widget"])]],
    );
    const outcome = strat.attempt(
      bareCall("m"),
      ctx({
        symbolTable,
        callerScope: ["Sub"],
        classAncestors: { Sub: ["Base", "M"], Base: ["Root"] },
        classExtends: { Sub: "Base", Base: "Root" },
      }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "root.rb", targetSymbolId: "Root#m" } });
  });
});

describe("schemaColumn MRO walk — ancestors ranked by MRO, not storage order (ymht3)", () => {
  const strat = new RubySchemaColumnSymbolResolutionStrategy();

  const column = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
    ...sym(symbolId, shortName, relPath, scope),
    isSchemaColumn: true,
  });

  it("reaches the inherited model's column through a chain that also carries a concern", () => {
    // Membership guard on the real shape: `class Agency < Firm; include Trackable`
    // — only `Firm` is table-backed, so the concern hop simply finds nothing and
    // the walk must still land on `Firm#name`. Storage order visits Firm first,
    // MRO order visits Trackable first; the answer is the same either way.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/firm.rb", [sym("Firm", "Firm", "app/models/firm.rb", [])]);
    table.setSchemaColumns([column("Firm#name", "name", "app/models/firm.rb", ["Firm"])]);
    const outcome = strat.attempt(
      bareCall("name"),
      ctx({
        symbolTable: table,
        callerFile: "app/models/agency.rb",
        callerScope: ["Agency"],
        callerSymbolId: "Agency#label",
        classAncestors: { Agency: ["Firm", "Trackable"] },
        classExtends: { Agency: "Firm" },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/firm.rb", targetSymbolId: "Firm#name" },
    });
  });

  it("prefers the column of the MRO-nearer scope when two hops both declare one", () => {
    // Order pin. Two table-backed classes on one chain both carrying `name`:
    // `class Sub < Base` where the walker ALSO recorded a table-backed `M` as an
    // include. Storage order answers Base#name; Ruby reaches M first.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/base.rb", [sym("Base", "Base", "app/models/base.rb", [])]);
    table.upsertFile("app/models/m.rb", [sym("M", "M", "app/models/m.rb", [])]);
    table.setSchemaColumns([
      column("Base#name", "name", "app/models/base.rb", ["Base"]),
      column("M#name", "name", "app/models/m.rb", ["M"]),
    ]);
    const outcome = strat.attempt(
      bareCall("name"),
      ctx({
        symbolTable: table,
        callerFile: "app/models/sub.rb",
        callerScope: ["Sub"],
        callerSymbolId: "Sub#label",
        classAncestors: { Sub: ["Base", "M"] },
        classExtends: { Sub: "Base" },
      }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "app/models/m.rb", targetSymbolId: "M#name" },
    });
  });
});
