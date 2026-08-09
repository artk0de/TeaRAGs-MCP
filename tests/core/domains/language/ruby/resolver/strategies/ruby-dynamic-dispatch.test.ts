import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AritySignature,
  type CallContext,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type HierarchyView,
  type InheritanceEdge,
  type SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT,
  RubyDynamicDispatchResolver,
  RubyIvarFieldSymbolResolutionStrategy,
  RubyLocalTypeSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { classifyRubyLiteralReceiver } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-dynamic-dispatch.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (
  symbolId: string,
  shortName: string,
  relPath: string,
  scope: string[],
  arity?: AritySignature,
  visibility?: "public" | "private" | "protected",
): SymbolDefinition => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
  ...(arity !== undefined ? { arity } : {}),
  ...(visibility !== undefined ? { visibility } : {}),
});

const tableWith = (...files: [string, SymbolDefinition[]][]): InMemoryGlobalSymbolTable => {
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

// bd f2jsb: resolveDispatch now returns DispatchFanoutOutcome; existing
// assertions target the edges payload, so unwrap (throwing on `ambiguous`
// keeps the assertion strict — these fixtures never exceed the fan-out cap).
const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

describe("RubyDynamicDispatchResolver (wbj3 — dynamic receivers)", () => {
  const resolver = new RubyDynamicDispatchResolver(cfg);

  it("returns [] for a bare call (receiver null — exact bare-call path owns it)", () => {
    const symbolTable = tableWith(["lib/helpers.rb", [sym("helper", "helper", "lib/helpers.rb", [])]]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "helper()", receiver: null, member: "helper", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a constant receiver (exact constant path owns it)", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User.find", "find", "app/models/user.rb", ["User"])]]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "User.find", receiver: "User", member: "find", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for the super sentinel (exact super path owns it)", () => {
    const symbolTable = tableWith();
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "super", receiver: SUPER_RECEIVER_SENTINEL, member: "save", startLine: 1 },
        ctx({ symbolTable, callerScope: ["Child"] }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a self receiver (exact self path owns it)", () => {
    const symbolTable = tableWith(["app/a.rb", [sym("A#helper", "helper", "app/a.rb", ["A"])]]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "self.helper", receiver: "self", member: "helper", startLine: 1 },
        ctx({ symbolTable, callerScope: ["A"] }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for a receiver with a local binding (exact localType path owns it — external never cones either)", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User#save", "save", "app/models/user.rb", ["User"])]]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "user.save", receiver: "user", member: "save", startLine: 1 },
        ctx({ symbolTable, localBindings: { user: [{ line: 1, type: "User" }] } }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] for an AR::Relation chain receiver (exact AR-guard path owns it)", () => {
    const symbolTable = tableWith(["app/a.rb", [sym("A#result", "result", "app/a.rb", ["A"])]]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "Product.where(active: true).result",
          receiver: "Product.where(active: true)",
          member: "result",
          startLine: 1,
        },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns [] when no ruby candidate matches the member short name (drop, not fabricate)", () => {
    const symbolTable = tableWith();
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "arr.frobnicate", receiver: "arr", member: "frobnicate", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("filters non-ruby candidates so cross-language pollution can't surface (arr.map → d3.js#map dropped)", () => {
    const symbolTable = tableWith([
      "vendor/assets/javascripts/d3.js",
      [sym("map", "map", "vendor/assets/javascripts/d3.js", [])],
    ]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "arr.map", receiver: "arr", member: "map", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([]);
  });

  // RECONCILE :123 — xlnub: unique survivor → confidence 1.0 (was DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT)
  it("narrows a unique dynamic-receiver member to a single edge with confidence 1.0", () => {
    const symbolTable = tableWith([
      "app/services/runner.rb",
      [sym("Runner#run", "run", "app/services/runner.rb", ["Runner"])],
    ]);
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "obj.run", receiver: "obj", member: "run", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/services/runner.rb",
        targetSymbolId: "Runner#run",
        edgeKind: "dynamic",
        confidence: 1.0,
      },
    ]);
  });

  // RECONCILE :143 — xlnub: `each` ∈ RUBY_DUCK_VOCAB → rename member to `recalc`
  it("fans a multi-candidate dynamic member out to N edges, confidence discount / N", () => {
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#recalc", "recalc", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#recalc", "recalc", "app/b.rb", ["B"])]],
    );
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "items.recalc", receiver: "items", member: "recalc", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toHaveLength(2);
    const expectedConfidence = DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT / 2;
    for (const edge of edges) {
      expect(edge.edgeKind).toBe("dynamic");
      expect(edge.confidence).toBeCloseTo(expectedConfidence, 10);
      expect(edge.sourceSymbolId).toBeNull();
    }
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#recalc", "B#recalc"]);
  });

  // RECONCILE :162 — xlnub: unique survivor → 1.0 regardless of custom discount
  it("honours a custom dynamicReceiverConfidence from config — unique survivor → 1.0", () => {
    const symbolTable = tableWith([
      "app/services/runner.rb",
      [sym("Runner#run", "run", "app/services/runner.rb", ["Runner"])],
    ]);
    const tuned = new RubyDynamicDispatchResolver({
      mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE,
      dynamicReceiverConfidence: 0.3,
    });
    const edges = edgesOf(
      tuned.resolveDispatch(
        { callText: "obj.run", receiver: "obj", member: "run", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].confidence).toBeCloseTo(1.0, 10);
  });

  it("suppresses fan-out for an index-access receiver (mktkk increment A)", () => {
    // Two in-project `fetch` defs → without suppression this fans out to 2
    // dynamic edges. The index receiver `opts[k]` yields an untrackable element
    // type, so it must produce NONE.
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#fetch", "fetch", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#fetch", "fetch", "app/b.rb", ["B"])]],
    );
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "opts[k].fetch", receiver: "opts[k]", member: "fetch", startLine: 1 },
        ctx({ symbolTable }),
      ),
    );
    expect(edges).toEqual([]);
  });

  it("suppresses fan-out for a TYPED-container index-access receiver too (Task 1.6 lift)", () => {
    // The sibling of the case above: `posts` IS bound to `Array<Post>`, so the
    // element type is known and `chainType` resolves the method precisely — a
    // discounted spray beside an exact answer is noise. Same outcome as the
    // untyped form, different reason, which is why the gate needs no branch to
    // tell them apart. Belt and braces: the index-access gate fires first, and
    // with it stubbed out `exactChainTypesReceiver` still suppresses this one
    // (only the untyped case above depends on the index gate existing).
    const symbolTable = tableWith(
      ["app/a.rb", [sym("A#fetch", "fetch", "app/a.rb", ["A"])]],
      ["app/b.rb", [sym("B#fetch", "fetch", "app/b.rb", ["B"])]],
    );
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "posts[0].fetch", receiver: "posts[0]", member: "fetch", startLine: 2 },
        ctx({
          symbolTable,
          localBindings: {
            posts: [
              { line: 1, type: "Post", typeRef: { form: "container", element: { form: "instance", name: "Post" } } },
            ],
          },
        }),
      ),
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
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "obj.fetch", receiver: "obj", member: "fetch", startLine: 1 },
        ctx({ symbolTable }),
      ),
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
      expect(edgesOf(resolver.resolveDispatch(call, ctx({ symbolTable })))).toEqual([]);
    });

    it("does NOT suppress a project member on an untyped receiver (control)", () => {
      const call = {
        callText: "agent.handle_details_post",
        receiver: "agent",
        member: "handle_details_post",
        startLine: 1,
      };
      // table seeds a def
      expect(edgesOf(resolver.resolveDispatch(call, ctx({ symbolTable }))).length).toBeGreaterThan(0);
    });

    // RECONCILE :242 — xlnub: `class` ∈ RUBY_DUCK_VOCAB → duck-killed; `save` stays
    it("does NOT suppress `save` (non-duck) but kills `class` via duck-vocabulary narrower", () => {
      // save is not in RUBY_DUCK_VOCAB → fans out (table seeds a def)
      const saveCall = { callText: "agent.save", receiver: "agent", member: "save", startLine: 1 };
      expect(edgesOf(resolver.resolveDispatch(saveCall, ctx({ symbolTable }))).length).toBeGreaterThan(0);
      // class IS in RUBY_DUCK_VOCAB → duck-vocabulary narrower kills the fan-out
      const classCall = { callText: "agent.class", receiver: "agent", member: "class", startLine: 1 };
      expect(edgesOf(resolver.resolveDispatch(classCall, ctx({ symbolTable })))).toEqual([]);
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
      expect(edgesOf(resolver.resolveDispatch(call, typedChainCtx))).toEqual([]);
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
      expect(edgesOf(resolver.resolveDispatch(call, untypedChainCtx)).length).toBeGreaterThan(0);
    });
  });

  // bd tea-rags-mcp-55950 — the deferral above used to require a DOT in the
  // receiver text, on the same assumption `chainType` itself carried until
  // e8feo: that a bare identifier is owned by `localType` or `ivarField`. Both
  // decline a receiver with no `localBindings` entry and no `@`, so once
  // `nullaryReceiverType` / `scopedReceiverType` started typing those, the exact
  // chain COULD answer them and the fan-out was answering first — N discounted
  // `dynamic` edges where one exact edge was available. The gate is typedness,
  // not shape; these two pin both directions of it.
  describe("typed BARE receiver defers to chainType as well (55950)", () => {
    // Two definers of `total`, so without the guard a fan-out IS produced —
    // which is what makes the guard observable rather than vacuous.
    const twoTotals = tableWith(
      [
        "app/models/invoice.rb",
        [
          sym("Invoice", "Invoice", "app/models/invoice.rb", []),
          sym("Invoice#total", "total", "app/models/invoice.rb", ["Invoice"]),
        ],
      ],
      [
        "app/models/cart.rb",
        [sym("Cart", "Cart", "app/models/cart.rb", []), sym("Cart#total", "total", "app/models/cart.rb", ["Cart"])],
      ],
    );
    const call = { callText: "latest_invoice.total", receiver: "latest_invoice", member: "total", startLine: 7 };

    it("returns [] when a bare receiver is typed by a nullary self-call return fact", () => {
      // `latest_invoice` has no localBindings entry and no `@`, so localType and
      // ivarField both decline; the caller's own class declares its return type,
      // which types the receiver to Invoice and hands `chainType` the resolution.
      const typedBareCtx = ctx({
        symbolTable: twoTotals,
        callerScope: ["Billing"],
        structuredReturnTypes: { "Billing#latest_invoice": { form: "instance", name: "Invoice" } },
      });
      expect(edgesOf(resolver.resolveDispatch(call, typedBareCtx))).toEqual([]);
    });

    it("still fans out when the bare receiver carries no derivable type (recall unchanged)", () => {
      // Same call, no return fact anywhere — the engine cannot type the receiver,
      // so the exact chain has nothing to defer TO and the dynamic path stands.
      expect(edgesOf(resolver.resolveDispatch(call, ctx({ symbolTable: twoTotals }))).length).toBeGreaterThan(0);
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
      expect(edgesOf(resolver.resolveDispatch(call, typedCtx))).toEqual([]);
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

  describe("untyped fan-out narrowing (xlnub)", () => {
    it("arity narrows to a single survivor → one edge confidence 1.0", () => {
      // two `perform` defs: (min1,max1) and (min2,max2); call argCount=2 → only (2,2) survives
      const symbolTable = tableWith(
        [
          "app/a.rb",
          [sym("A#perform", "perform", "app/a.rb", ["A"], { minRequired: 1, maxPositional: 1, hasSplat: false })],
        ],
        [
          "app/b.rb",
          [sym("B#perform", "perform", "app/b.rb", ["B"], { minRequired: 2, maxPositional: 2, hasSplat: false })],
        ],
      );
      const edges = edgesOf(
        resolver.resolveDispatch(
          { callText: "x.perform(1, 2)", receiver: "x", member: "perform", startLine: 1, argCount: 2 },
          ctx({ symbolTable }),
        ),
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].targetSymbolId).toBe("B#perform");
      expect(edges[0].confidence).toBe(1.0);
      expect(edges[0].edgeKind).toBe("dynamic");
    });

    it("duck-vocabulary member → no edges (each — regression guard for Ruby wiring)", () => {
      // `each` ∈ RUBY_DUCK_VOCAB → DuckVocabularyNarrower kills the whole fan-out
      const symbolTable = tableWith(
        ["app/a.rb", [sym("A#each", "each", "app/a.rb", ["A"])]],
        ["app/b.rb", [sym("B#each", "each", "app/b.rb", ["B"])]],
      );
      const edges = edgesOf(
        resolver.resolveDispatch(
          { callText: "items.each", receiver: "items", member: "each", startLine: 1 },
          ctx({ symbolTable }),
        ),
      );
      expect(edges).toEqual([]);
    });

    it("custom cfg discount applied to m>1 residual: 2 non-duck same-name defs → 2 edges confidence discount/2", () => {
      // tuned cfg 0.3 + two non-duck `run` defs (no arity) → m=2 residual → 0.3/2 = 0.15 each
      const symbolTable = tableWith(
        ["app/a.rb", [sym("A#run", "run", "app/a.rb", ["A"])]],
        ["app/b.rb", [sym("B#run", "run", "app/b.rb", ["B"])]],
      );
      const tuned = new RubyDynamicDispatchResolver({
        mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE,
        dynamicReceiverConfidence: 0.3,
      });
      const edges = edgesOf(
        tuned.resolveDispatch(
          { callText: "obj.run", receiver: "obj", member: "run", startLine: 1 },
          ctx({ symbolTable }),
        ),
      );
      expect(edges).toHaveLength(2);
      for (const edge of edges) {
        expect(edge.confidence).toBeCloseTo(0.15, 10); // 0.3 / 2
        expect(edge.edgeKind).toBe("dynamic");
      }
    });

    it("irreducible residual (m>1) → m edges confidence discount/m", () => {
      // 3 same-arity public `account` defs → 3 edges confidence DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT/3
      const symbolTable = tableWith(
        [
          "app/a.rb",
          [
            sym(
              "A#account",
              "account",
              "app/a.rb",
              ["A"],
              { minRequired: 0, maxPositional: 0, hasSplat: false },
              "public",
            ),
          ],
        ],
        [
          "app/b.rb",
          [
            sym(
              "B#account",
              "account",
              "app/b.rb",
              ["B"],
              { minRequired: 0, maxPositional: 0, hasSplat: false },
              "public",
            ),
          ],
        ],
        [
          "app/c.rb",
          [
            sym(
              "C#account",
              "account",
              "app/c.rb",
              ["C"],
              { minRequired: 0, maxPositional: 0, hasSplat: false },
              "public",
            ),
          ],
        ],
      );
      const edges = edgesOf(
        resolver.resolveDispatch(
          { callText: "x.account", receiver: "x", member: "account", startLine: 1, argCount: 0 },
          ctx({ symbolTable }),
        ),
      );
      expect(edges).toHaveLength(3);
      const expectedConfidence = DYNAMIC_RECEIVER_CONFIDENCE_DEFAULT / 3;
      for (const edge of edges) {
        expect(edge.confidence).toBeCloseTo(expectedConfidence, 10);
        expect(edge.edgeKind).toBe("dynamic");
      }
    });

    it("private candidates dropped under explicit receiver → unique survivor → confidence 1.0", () => {
      // x.helper: one private, one public, same arity → only public survives → confidence 1.0
      const symbolTable = tableWith(
        [
          "app/a.rb",
          [
            sym(
              "A#helper",
              "helper",
              "app/a.rb",
              ["A"],
              { minRequired: 0, maxPositional: 0, hasSplat: false },
              "private",
            ),
          ],
        ],
        [
          "app/b.rb",
          [
            sym(
              "B#helper",
              "helper",
              "app/b.rb",
              ["B"],
              { minRequired: 0, maxPositional: 0, hasSplat: false },
              "public",
            ),
          ],
        ],
      );
      const edges = edgesOf(
        resolver.resolveDispatch(
          { callText: "x.helper", receiver: "x", member: "helper", startLine: 1, argCount: 0 },
          ctx({ symbolTable }),
        ),
      );
      expect(edges).toHaveLength(1);
      expect(edges[0].targetSymbolId).toBe("B#helper");
      expect(edges[0].confidence).toBe(1.0);
      expect(edges[0].edgeKind).toBe("dynamic");
    });
  });
});

describe("classifyRubyLiteralReceiver (d9o7o)", () => {
  it("maps literal receivers to their core type; non-literals → null", () => {
    expect(classifyRubyLiteralReceiver('"s"')).toBe("String");
    expect(classifyRubyLiteralReceiver("[1, 2]")).toBe("Array");
    expect(classifyRubyLiteralReceiver("{ a: 1 }")).toBe("Hash");
    expect(classifyRubyLiteralReceiver(":sym")).toBe("Symbol");
    expect(classifyRubyLiteralReceiver("123")).toBe("Integer");
    expect(classifyRubyLiteralReceiver("1.5")).toBe("Float");
    expect(classifyRubyLiteralReceiver("user")).toBeNull();
    expect(classifyRubyLiteralReceiver(null)).toBeNull();
  });
});

describe("RubyDynamicDispatchResolver — Tier-2+3 cascade wiring (d9o7o)", () => {
  const resolver = new RubyDynamicDispatchResolver(cfg);

  it("BlockNarrower wired: a block-passing call prefers the yielding definer", () => {
    const symbolTable = tableWith(
      ["app/a.rb", [{ ...sym("A#process", "process", "app/a.rb", ["A"]), acceptsBlock: true }]],
      ["app/b.rb", [{ ...sym("B#process", "process", "app/b.rb", ["B"]), acceptsBlock: false }]],
    );
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "worker.process { }", receiver: "worker", member: "process", startLine: 1, passesBlock: true },
        ctx({ symbolTable }),
      ),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#process"]);
    expect(edges[0].confidence).toBe(1.0);
  });

  it("KwargNarrower wired: drops a definer whose required kwarg the call omits", () => {
    const symbolTable = tableWith(
      ["app/a.rb", [{ ...sym("A#run", "run", "app/a.rb", ["A"]), kwargs: { required: ["mode"], hasSplat: false } }]],
      [
        "app/b.rb",
        [{ ...sym("B#run", "run", "app/b.rb", ["B"]), kwargs: { required: ["mode", "flag"], hasSplat: false } }],
      ],
    );
    const edges = edgesOf(
      resolver.resolveDispatch(
        { callText: "worker.run(mode: 1)", receiver: "worker", member: "run", startLine: 1, kwargKeys: ["mode"] },
        ctx({ symbolTable }),
      ),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#run"]);
  });
});

// ---------------------------------------------------------------------------
// bd tea-rags-mcp-j9xpf — `result = Svc.call(…)` leaves `result` with NO
// localBindings entry (the walker cannot know another file's return type), so
// without this gate the dynamic component fans `result.successful?` out to every
// same-named def in the project, PREEMPTING the precise `returnTypeBinding` pass
// (resolveDispatch runs before resolve()). The gate mirrors the one `chainType`
// already gets: defer exactly when the exact path will emit an edge, so recall
// is untouched wherever it cannot.
// ---------------------------------------------------------------------------
describe("RubyDynamicDispatchResolver — defers to the returnTypeBinding pass (j9xpf)", () => {
  const resolver = new RubyDynamicDispatchResolver(cfg);
  const call = { callText: "result.successful?", receiver: "result", member: "successful?", startLine: 2 };
  const twoDefiners = () =>
    tableWith(
      [
        "app/service_result.rb",
        [
          sym("ServiceResult", "ServiceResult", "app/service_result.rb", []),
          sym("ServiceResult#successful?", "successful?", "app/service_result.rb", ["ServiceResult"]),
        ],
      ],
      [
        "app/cache_entry.rb",
        [
          sym("CacheEntry", "CacheEntry", "app/cache_entry.rb", []),
          sym("CacheEntry#successful?", "successful?", "app/cache_entry.rb", ["CacheEntry"]),
        ],
      ],
    );

  it("returns [] when a SCOPE-QUALIFIED binding types the receiver to an in-project class", () => {
    const outcome = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable: twoDefiners(),
        localCallBindings: { result: "Billing::Create.call" },
        structuredReturnTypes: { "Billing::Create#call": { form: "instance", name: "ServiceResult" } },
      }),
    );
    expect(edgesOf(outcome)).toEqual([]);
  });

  it("returns [] when the type comes from the shared template via the ancestor MRO", () => {
    const outcome = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable: twoDefiners(),
        localCallBindings: { result: "Billing::Create.call" },
        classAncestors: { "Billing::Create": ["KindOfService"] },
        structuredReturnTypes: { "KindOfService#call": { form: "instance", name: "ServiceResult" } },
      }),
    );
    expect(edgesOf(outcome)).toEqual([]);
  });

  it("STILL fans out when the binding's return type is unknown (recall unchanged)", () => {
    const outcome = resolver.resolveDispatch(
      call,
      ctx({ symbolTable: twoDefiners(), localCallBindings: { result: "Billing::Create.call" } }),
    );
    expect(
      edgesOf(outcome)
        .map((e) => e.targetSymbolId)
        .sort(),
    ).toEqual(["CacheEntry#successful?", "ServiceResult#successful?"]);
  });

  it("STILL fans out when the return type is a gem/stdlib class with no in-project def", () => {
    const outcome = resolver.resolveDispatch(
      call,
      ctx({
        symbolTable: twoDefiners(),
        localCallBindings: { result: "Billing::Create.call" },
        structuredReturnTypes: { "Billing::Create#call": { form: "instance", name: "Dry::Monads::Result" } },
      }),
    );
    expect(edgesOf(outcome)).toHaveLength(2);
  });
});

/**
 * Convention-typed receiver deferral (bd tea-rags-mcp-htffz, residual item C2).
 * The fan-out steps aside for a receiver the `conventionReceiver` pass pins,
 * exactly as it already does for one `typeOfReceiver` answers (epydb / 55950) and
 * for the `ivarField` / `returnTypeBinding` targets above. Same gate shape and
 * same reasoning: gated on the RESOLVED target, so a receiver the exact path
 * cannot answer still fans out and the resolve tally is unchanged.
 */
describe("RubyDynamicDispatchResolver — convention-typed receiver deferral (htffz)", () => {
  const resolver = new RubyDynamicDispatchResolver(cfg);

  /** `Payment` pins `recalc`; two other classes declare the same short name. */
  const conventionTable = (declarePaymentMember = true): InMemoryGlobalSymbolTable =>
    tableWith(
      [
        "app/models/payment.rb",
        declarePaymentMember
          ? [
              sym("Payment", "Payment", "app/models/payment.rb", []),
              sym("Payment#recalc", "recalc", "app/models/payment.rb", ["Payment"]),
            ]
          : [sym("Payment", "Payment", "app/models/payment.rb", [])],
      ],
      ["app/models/ledger.rb", [sym("Ledger#recalc", "recalc", "app/models/ledger.rb", ["Ledger"])]],
      ["app/models/journal.rb", [sym("Journal#recalc", "recalc", "app/models/journal.rb", ["Journal"])]],
    );

  /** Minimal HierarchyView: a flat descendants map keyed by fqName. */
  const hierarchyOf = (descendants: Record<string, string[]>): HierarchyView => {
    const toEdges = (names: string[]): InheritanceEdge[] =>
      names.map((sourceFqName) => ({
        sourceFqName,
        ancestorFqName: "",
        ancestorSymbolId: null,
        kind: "super" as const,
        depth: 1,
      }));
    return {
      getAncestors: () => [],
      getDescendants: (fqName) => toEdges(descendants[fqName] ?? []),
    };
  };

  const callOn = (receiver: string) => ({
    callText: `${receiver}.recalc`,
    receiver,
    member: "recalc",
    startLine: 1,
  });

  const targetsOf = (outcome: DispatchFanoutOutcome): (string | null)[] =>
    edgesOf(outcome)
      .map((e) => e.targetSymbolId)
      .sort();

  it("returns [] for a bare receiver the convention pass pins — the exact edge owns it", () => {
    expect(edgesOf(resolver.resolveDispatch(callOn("payment"), ctx({ symbolTable: conventionTable() })))).toEqual([]);
  });

  it("STILL fans out when the convention class has declared subtypes (precision gate closed)", () => {
    const outcome = resolver.resolveDispatch(
      callOn("payment"),
      ctx({ symbolTable: conventionTable(), hierarchy: hierarchyOf({ Payment: ["CardPayment"] }) }),
    );
    expect(targetsOf(outcome)).toEqual(["Journal#recalc", "Ledger#recalc", "Payment#recalc"]);
  });

  it("STILL fans out when the convention class declares no such member (no file-only edge)", () => {
    const outcome = resolver.resolveDispatch(callOn("payment"), ctx({ symbolTable: conventionTable(false) }));
    expect(targetsOf(outcome)).toEqual(["Journal#recalc", "Ledger#recalc"]);
  });

  it("STILL fans out when the receiver names no declared class", () => {
    expect(edgesOf(resolver.resolveDispatch(callOn("widget"), ctx({ symbolTable: conventionTable() })))).toHaveLength(
      3,
    );
  });

  // ── the carve-out the C2 oracle demanded, and what retired it ──────────────
  // htffz kept the fan-out for an untyped `@ivar` inside a class because
  // `ivarField` DROPped nine slots ahead of `conventionReceiver`: deferring
  // would have traded N discounted edges for NO edge at all, at 1173 of 2704
  // convention-typed taxdome sites. bd r2gjj then moved the convention INSIDE
  // `ivarField` as its last tier, so the chain now answers those very sites —
  // measured 1173 of 1173 — and the deferral is a strict win (bd eaml5). The
  // carve-out itself is unchanged and still guards the population `ivarField`
  // DROPs; see the eaml5 block below for its remaining shapes.
  it("defers for an untyped @ivar inside a class the convention types — ivarField's last tier pins it", () => {
    const outcome = resolver.resolveDispatch(
      callOn("@payment"),
      ctx({ symbolTable: conventionTable(), callerScope: ["Reporter"] }),
    );
    expect(edgesOf(outcome)).toEqual([]);
  });

  it("defers for an @ivar receiver at top level, where ivarField CONTINUEs and the chain reaches the pass", () => {
    expect(edgesOf(resolver.resolveDispatch(callOn("@payment"), ctx({ symbolTable: conventionTable() })))).toEqual([]);
  });
});

/**
 * `@ivar` fan-out collapse over the convention tier (bd tea-rags-mcp-eaml5).
 *
 * The deferral gate reads ONE authority — `resolveIvarFieldTarget`, whatever
 * `ivarField` resolves through — so the fan-out and the chain cannot disagree
 * about which `@ivar` receivers the exact path owns. These tests state that
 * agreement as behaviour: whenever the fan-out steps aside the pass MUST pin a
 * target, and wherever the pass DROPs the fan-out MUST survive. A gate reading
 * only the fact channels (the pre-eaml5 shape) leaves the first case emitting N
 * discounted edges while the chain had an exact one; a gate that defers on
 * receiver SHAPE instead of on the resolved target loses the rest outright,
 * because `ivarField` terminates the chain at position 4.
 */
describe("RubyDynamicDispatchResolver — @ivar convention-tier collapse (eaml5)", () => {
  const resolver = new RubyDynamicDispatchResolver(cfg);
  const ivarField = new RubyIvarFieldSymbolResolutionStrategy(cfg);

  /** `Payment` pins `recalc`; two unrelated classes declare the same short name. */
  const table = (declarePaymentMember = true): InMemoryGlobalSymbolTable =>
    tableWith(
      [
        "app/models/payment.rb",
        declarePaymentMember
          ? [
              sym("Payment", "Payment", "app/models/payment.rb", []),
              sym("Payment#recalc", "recalc", "app/models/payment.rb", ["Payment"]),
            ]
          : [sym("Payment", "Payment", "app/models/payment.rb", [])],
      ],
      ["app/models/ledger.rb", [sym("Ledger#recalc", "recalc", "app/models/ledger.rb", ["Ledger"])]],
      ["app/models/journal.rb", [sym("Journal#recalc", "recalc", "app/models/journal.rb", ["Journal"])]],
    );

  const hierarchyOf = (descendants: Record<string, string[]>): HierarchyView => ({
    getAncestors: () => [],
    getDescendants: (fqName) =>
      (descendants[fqName] ?? []).map(
        (sourceFqName): InheritanceEdge => ({
          sourceFqName,
          ancestorFqName: "",
          ancestorSymbolId: null,
          kind: "super",
          depth: 1,
        }),
      ),
  });

  const callOn = (receiver: string) => ({
    callText: `${receiver}.recalc`,
    receiver,
    member: "recalc",
    startLine: 1,
  });

  const targetsOf = (outcome: DispatchFanoutOutcome): (string | null)[] =>
    edgesOf(outcome)
      .map((e) => e.targetSymbolId)
      .sort();

  /** Inside a class, so `ivarFieldOwnsReceiver` holds and the pass terminates the chain. */
  const inClass = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext =>
    ctx({ callerScope: ["Reporter"], ...over });

  it("collapses the fan-out to the exact edge the ivarField pass pins for the same call", () => {
    const call = callOn("@payment");
    const context = inClass({ symbolTable: table() });

    // The collapse is only sound because BOTH halves hold at the same site: the
    // fan-out yields, and the pass that runs instead answers.
    expect(edgesOf(resolver.resolveDispatch(call, context))).toEqual([]);
    expect(ivarField.attempt(call, context)).toEqual({
      kind: "resolved",
      target: expect.objectContaining({ targetSymbolId: "Payment#recalc" }),
    });
  });

  it("STILL fans out when the convention class has declared subtypes — the pass DROPs there", () => {
    const call = callOn("@payment");
    const context = inClass({ symbolTable: table(), hierarchy: hierarchyOf({ Payment: ["CardPayment"] }) });

    expect(targetsOf(resolver.resolveDispatch(call, context))).toEqual([
      "Journal#recalc",
      "Ledger#recalc",
      "Payment#recalc",
    ]);
    expect(ivarField.attempt(call, context).kind).toBe("drop");
  });

  it("STILL fans out when the convention class declares no such member (no file-only edge)", () => {
    const call = callOn("@payment");
    const context = inClass({ symbolTable: table(false) });

    expect(targetsOf(resolver.resolveDispatch(call, context))).toEqual(["Journal#recalc", "Ledger#recalc"]);
    expect(ivarField.attempt(call, context).kind).toBe("drop");
  });

  it("STILL fans out when the @ivar names no declared class", () => {
    const call = callOn("@widget");
    const context = inClass({ symbolTable: table() });

    expect(edgesOf(resolver.resolveDispatch(call, context))).toHaveLength(3);
    expect(ivarField.attempt(call, context).kind).toBe("drop");
  });

  it("keeps deferring for an @ivar a fact channel types — the fact gate owns it, not the convention", () => {
    const call = callOn("@payment");
    const context = inClass({ symbolTable: table(), ivarTypes: { Reporter: { "@payment": "Payment" } } });

    expect(edgesOf(resolver.resolveDispatch(call, context))).toEqual([]);
    expect(ivarField.attempt(call, context)).toEqual({
      kind: "resolved",
      target: expect.objectContaining({ targetSymbolId: "Payment#recalc" }),
    });
  });
});
