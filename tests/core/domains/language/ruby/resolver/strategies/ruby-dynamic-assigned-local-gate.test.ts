/**
 * Ruby dynamic fan declines an untyped ASSIGNED local (bd tea-rags-mcp-m99j1.1.59).
 *
 * `conn = connection_helper; conn.get(...)` — the walker knows `conn` is a local
 * of the def but nothing typed it, so a short-name fan over every in-project
 * `#get` is wrong-type noise. The gate sits behind
 * `CODEGRAPH_RB_ASSIGNED_LOCAL_GATE` (`ResolverConfig.assignedLocalGate`).
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyDynamicDispatchResolver,
  RubyLocalTypeSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const symbolTable = new InMemoryGlobalSymbolTable();
symbolTable.upsertFile("app/models/widget.rb", [
  sym("Widget", "Widget", "app/models/widget.rb", []),
  sym("Widget#refresh_feed", "refresh_feed", "app/models/widget.rb", ["Widget"]),
]);

const ctx = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable,
  ...over,
});

const call = (receiver: string): CallRef => ({
  callText: `${receiver}.refresh_feed`,
  receiver,
  member: "refresh_feed",
  startLine: 3,
});

const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

const ON: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE, assignedLocalGate: true };
const OFF: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE, assignedLocalGate: false };

describe("Ruby dynamic fan — assigned-local gate (m99j1.1.59)", () => {
  it("declines an untyped assigned local with an in-project namesake when the gate is on", () => {
    const edges = edgesOf(
      new RubyDynamicDispatchResolver(ON).resolveDispatch(call("w"), ctx({ assignedLocals: ["w"] })),
    );
    expect(edges).toEqual([]);
  });

  it("fans it by default — OFF since o9mk8, an unset env means off (14% of the dropped rows were TRUE edges)", () => {
    const resolver = new RubyDynamicDispatchResolver({ mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE });
    const edges = edgesOf(resolver.resolveDispatch(call("w"), ctx({ assignedLocals: ["w"] })));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Widget#refresh_feed"]);
  });

  it("still fans on the same site when the gate is off", () => {
    const edges = edgesOf(
      new RubyDynamicDispatchResolver(OFF).resolveDispatch(call("w"), ctx({ assignedLocals: ["w"] })),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Widget#refresh_feed"]);
  });

  it("still fans on a parameter receiver (not an assigned local) with the gate on", () => {
    const edges = edgesOf(
      new RubyDynamicDispatchResolver(ON).resolveDispatch(call("widget_param"), ctx({ assignedLocals: ["w"] })),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Widget#refresh_feed"]);
  });

  it("keeps the exact edge of a TYPED assigned local with the gate on", () => {
    const typed = ctx({ assignedLocals: ["w"], localBindings: { w: [{ line: 2, type: "Widget" }] } });
    const outcome = new RubyLocalTypeSymbolResolutionStrategy(ON).attempt(call("w"), typed);
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.target.targetSymbolId).toBe("Widget#refresh_feed");
  });
});
