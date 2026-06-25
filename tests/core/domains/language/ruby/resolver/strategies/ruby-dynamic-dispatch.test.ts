import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
  RubyDynamicDispatchResolver,
  RubyLocalTypeSymbolResolutionStrategy,
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
      { callText: "obj.run", receiver: "obj", member: "run", startLine: 1 },
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
      { callText: "obj.run", receiver: "obj", member: "run", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeCloseTo(0.3, 10);
  });

  it("suppresses fan-out for an index-access receiver (mktkk increment A)", () => {
    // Two in-project `fetch` defs → without suppression this fans out to 2
    // dynamic edges. The index receiver `opts[k]` yields an untrackable element
    // type, so it must produce NONE.
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#fetch", "fetch", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#fetch", "fetch", "app/b.rb", ["B"])]],
    );
    const edges = resolver.resolveDispatch(
      { callText: "opts[k].fetch", receiver: "opts[k]", member: "fetch", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges).toEqual([]);
  });

  it("still fans out a bare-identifier untyped receiver (increment B, NOT suppressed here)", () => {
    // Same two-`fetch`-defs table; a bare-identifier receiver `obj` is the
    // generic untyped fan-out the index guard must NOT touch.
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#fetch", "fetch", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#fetch", "fetch", "app/b.rb", ["B"])]],
    );
    const edges = resolver.resolveDispatch(
      { callText: "obj.fetch", receiver: "obj", member: "fetch", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(edges.length).toBeGreaterThan(0);
  });

  describe("increment D / i9id8 — AR-core member suppression on untyped receivers", () => {
    // Seed the table with in-project defs for every member used in this block so
    // that the control/exclusion cases genuinely fan out absent the guard.
    const symbolTable = tableWith([
      "app/a.rb",
      [
        sym("A#update", "update", "app/a.rb", ["A"]),
        sym("A#handle_details_post", "handle_details_post", "app/a.rb", ["A"]),
        sym("A#save", "save", "app/a.rb", ["A"]),
        sym("A#class", "class", "app/a.rb", ["A"]),
      ],
    ]);

    it("suppresses fan-out for an AR-core member on an untyped receiver (V_core)", () => {
      // table seeded with an in-project `update` def so a fan-out WOULD occur
      const call = {
        callText: "agent.update",
        receiver: "agent",
        member: "update",
        startLine: 1,
      };
      expect(resolver.resolveDispatch(call, ctx({ symbolTable }))).toEqual([]);
    });

    it("does NOT suppress a project member on an untyped receiver (control)", () => {
      const call = {
        callText: "agent.handle_details_post",
        receiver: "agent",
        member: "handle_details_post",
        startLine: 1,
      };
      expect(resolver.resolveDispatch(call, ctx({ symbolTable })).length).toBeGreaterThan(0); // table seeds a def
    });

    it("does NOT suppress an EXCLUDED member (save / class stay fan-out)", () => {
      for (const member of ["save", "class"]) {
        const call = {
          callText: `agent.${member}`,
          receiver: "agent",
          member,
          startLine: 1,
        };
        expect(resolver.resolveDispatch(call, ctx({ symbolTable })).length).toBeGreaterThan(0); // table seeds a def
      }
    });
  });

  describe("typeable chain receiver guard (epydb — defer to chainType, suppress dynamic fan-out)", () => {
    // Seed with an in-project def for the same member name so without the guard
    // a dynamic fan-out WOULD be produced. This makes the green/red flip observable.
    const accountSymbolTable = tableWith([
      "app/models/account.rb",
      [sym("Account#balance", "balance", "app/models/account.rb", ["Account"])],
    ]);

    it("returns [] when chain receiver is typeable (defers to chainType, suppresses dynamic fan-out)", () => {
      // user.account: head `user` is bound to User in localBindings; hop `account`
      // resolves via structuredReturnTypes["User#account"] → {form:"instance", name:"Account"}.
      // typeOfReceiver returns a known instance type → guard fires → [].
      const call = {
        callText: "user.account.balance",
        receiver: "user.account",
        member: "balance",
        startLine: 5,
      };
      const typedChainCtx = ctx({
        symbolTable: accountSymbolTable,
        localBindings: { user: [{ line: 1, type: "User" }] },
        structuredReturnTypes: { "User#account": { form: "instance", name: "Account" } },
      });
      expect(resolver.resolveDispatch(call, typedChainCtx)).toEqual([]);
    });

    it("still fans out when chain receiver is untypeable (head has no binding — dynamic path unchanged)", () => {
      // unknown.account: head `unknown` has no localBindings entry → typeOfReceiver
      // returns undefined → guard does NOT fire → existing dynamic fan-out runs.
      const call = {
        callText: "unknown.account.balance",
        receiver: "unknown.account",
        member: "balance",
        startLine: 5,
      };
      const untypedChainCtx = ctx({
        symbolTable: accountSymbolTable,
        // No localBindings — head is unresolvable
      });
      expect(resolver.resolveDispatch(call, untypedChainCtx).length).toBeGreaterThan(0);
    });
  });

  describe("chain-order safety: typed receiver resolves exact via localType, never reaches member guard", () => {
    // A TYPED receiver (localBindings binds `model` → "Model") with an in-project
    // `Model#update` def resolves EXACT via the localType chain strategy, not
    // suppressed by the AR-core member guard. Two assertions together:
    //   1. resolveDispatch returns [] (typed receiver exits at the localBindings
    //      guard, before the isExternalQualifiedMember check — correct ordering).
    //   2. The chain strategy (RubyLocalTypeSymbolResolutionStrategy) resolves
    //      model.update to Model#update exactly — the in-project edge is NOT lost.
    //
    // The table includes BOTH the class-level "Model" symbol (so resolveConstant
    // can map the type name to its file) AND the "Model#update" method symbol (so
    // the method lookup succeeds). Without the class symbol, resolveConstant finds
    // nothing and the localType strategy returns DROP — which would make the test
    // vacuous (DROP != suppression by member guard).
    const modelTable = tableWith([
      "app/models/model.rb",
      [
        sym("Model", "Model", "app/models/model.rb", []),
        sym("Model#update", "update", "app/models/model.rb", ["Model"]),
      ],
    ]);

    const typedCtx = ctx({
      symbolTable: modelTable,
      localBindings: { model: [{ line: 1, type: "Model" }] },
    });

    it("resolveDispatch returns [] for a typed receiver (localBindings guard short-circuits before any dynamic fan-out)", () => {
      // A typed receiver (localBindings binds `model` → "Model") never reaches the
      // dynamic dispatch path — the localBindings guard returns [] early. This is an
      // early-exit regression guard: it proves the resolver does NOT produce a
      // spurious dynamic edge for a typed receiver, regardless of AR-core membership.
      // The in-project-resolution-is-preserved proof is the sibling `Model#update` test below.
      const call = { callText: "model.update", receiver: "model", member: "update", startLine: 2 };
      expect(resolver.resolveDispatch(call, typedCtx)).toEqual([]);
    });

    it("the localType chain strategy resolves model.update to the in-project Model#update target", () => {
      const strategy = new RubyLocalTypeSymbolResolutionStrategy(cfg);
      const call = { callText: "model.update", receiver: "model", member: "update", startLine: 2 };
      const RESOLVED = "resolved";
      const outcome = strategy.attempt(call, typedCtx);
      expect(outcome.kind).toBe(RESOLVED);
      if (outcome.kind === RESOLVED) {
        expect(outcome.target.targetSymbolId).toBe("Model#update");
        expect(outcome.target.targetRelPath).toBe("app/models/model.rb");
      }
    });
  });
});
