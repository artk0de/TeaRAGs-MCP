import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
  RubyDynamicDispatchResolver,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";
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

describe("RubyDynamicDispatchResolver (wbj3 — dynamic receivers)", () => {
  const resolver = new RubyDynamicDispatchResolver(cfg);

  it("returns [] for a bare call (receiver null — exact bare-call path owns it)", () => {
    const symbolTable = tableWith(["lib/helpers.rb", [sym("helper", "helper", "lib/helpers.rb", [])]]);
    const edges = resolver.resolveDispatch(
      { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a constant receiver (exact constant path owns it)", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User.find", "find", "app/models/user.rb", ["User"])]]);
    const edges = resolver.resolveDispatch(
      { callText: "User.find", receiver: "User", member: "find", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for the super sentinel (exact super path owns it)", () => {
    const symbolTable = tableWith();
    const edges = resolver.resolveDispatch(
      { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "save", startLine: 1 },
      ctx({ symbolTable, callerScope: ["Child"] }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a self receiver (exact self path owns it)", () => {
    const symbolTable = tableWith(["app/a.rb", [sym("A#helper", "helper", "app/a.rb", ["A"])]]);
    const edges = resolver.resolveDispatch(
      { callText: "self.helper", receiver: "self", member: "helper", startLine: 1 },
      ctx({ symbolTable, callerScope: ["A"] }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a receiver with a local binding (exact localType path owns it — external never cones either)", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User#save", "save", "app/models/user.rb", ["User"])]]);
    const edges = resolver.resolveDispatch(
      { callText: "user.save", receiver: "user", member: "save", startLine: 1 },
      ctx({ symbolTable, localBindings: { user: [{ line: 1, type: "User" }] } }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for an AR::Relation chain receiver (exact AR-guard path owns it)", () => {
    const symbolTable = tableWith(["app/a.rb", [sym("A#result", "result", "app/a.rb", ["A"])]]);
    const edges = resolver.resolveDispatch(
      {
        callText: "Product.where(active: true).result",
        receiver: "Product.where(active: true)",
        member: "result",
        startLine: 1,
      },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] when no ruby candidate matches the member short name (drop, not fabricate)", () => {
    const symbolTable = tableWith();
    const edges = resolver.resolveDispatch(
      { callText: "arr.frobnicate", receiver: "arr", member: "frobnicate", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([]);
  });

  it("filters non-ruby candidates so cross-language pollution can't surface (arr.map → d3.js#map dropped)", () => {
    const symbolTable = tableWith([
      "vendor/assets/javascripts/d3.js",
      [sym("map", "map", "vendor/assets/javascripts/d3.js", [])],
    ]);
    const edges = resolver.resolveDispatch(
      { callText: "arr.map", receiver: "arr", member: "map", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([]);
  });

  it("resolves a unique dynamic-receiver member to a single discounted `dynamic` edge", () => {
    const symbolTable = tableWith([
      "app/services/runner.rb",
      [sym("Runner#run", "run", "app/services/runner.rb", ["Runner"])],
    ]);
    const edges = resolver.resolveDispatch(
      { callText: "obj[k].run", receiver: "obj[k]", member: "run", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/services/runner.rb",
        targetSymbolId: "Runner#run",
        edgeKind: "dynamic",
        confidence: DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
      },
    ]);
  });

  it("fans a multi-candidate dynamic member out to N edges, confidence discount / N", () => {
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#each", "each", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#each", "each", "app/b.rb", ["B"])]],
    );
    const edges = resolver.resolveDispatch(
      { callText: "items.each", receiver: "items", member: "each", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toHaveLength(2);
    const expectedConfidence = DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT / 2;
    for (const edge of edges) {
      expect(edge.edgeKind).toBe("dynamic");
      expect(edge.confidence).toBeCloseTo(expectedConfidence, 10);
      expect(edge.sourceSymbolId).toBeNull();
    }
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#each", "B#each"]);
  });

  it("honours a custom dynamicReceiverConfidence from config", () => {
    const symbolTable = tableWith([
      "app/services/runner.rb",
      [sym("Runner#run", "run", "app/services/runner.rb", ["Runner"])],
    ]);
    const tuned = new RubyDynamicDispatchResolver({
      mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      dynamicReceiverConfidence: 0.3,
    });
    const edges = tuned.resolveDispatch(
      { callText: "obj[k].run", receiver: "obj[k]", member: "run", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeCloseTo(0.3, 10);
  });
});
