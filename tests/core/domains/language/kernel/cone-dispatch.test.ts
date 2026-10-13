import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  HierarchySnapshot,
  HierarchyView,
  InheritanceEdge,
  InheritanceEdgeRow,
  SymbolResolutionTarget,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../../src/core/contracts/types/language.js";
import { ConeDispatchResolver } from "../../../../../src/core/domains/language/kernel/cone-dispatch.js";
import { MapHierarchyView } from "../../../../../src/core/domains/trajectory/codegraph/hierarchy-view/index.js";

/**
 * Fake `ConeTypeLocator` — the engine is language-neutral, so the Ruby /
 * Python resolution conventions are stubbed out entirely. `directMethods` maps
 * `"<typeName>#<member>"` → its resolved target (an override pin); `typeFiles`
 * maps `typeName` → declaring file. Anything absent resolves to `null`.
 */
const locatorWith = (
  directMethods: Record<string, SymbolResolutionTarget>,
  typeFiles: Record<string, string> = {},
): ConeTypeLocator => ({
  resolveTypeFile: (typeName: string): string | null => typeFiles[typeName] ?? null,
  findDirectMethod: (typeName: string, member: string): SymbolResolutionTarget | null =>
    directMethods[`${typeName}#${member}`] ?? null,
});

/** Fake `HierarchyView` — only `getDescendants` is exercised by the cone. */
const hierarchyWith = (descendantsByAncestor: Record<string, string[]>): HierarchyView => ({
  getAncestors: () => [],
  getDescendants: (fqName: string): readonly InheritanceEdge[] =>
    (descendantsByAncestor[fqName] ?? []).map((sourceFqName) => ({
      sourceFqName,
      ancestorFqName: fqName,
      ancestorSymbolId: null,
      kind: "super",
      depth: 1,
    })),
});

const ctx = (over: Partial<CallContext>): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  // The engine never touches the symbol table (the locator owns lookup); a bare
  // stub satisfies the type without participating in the behavior.
  symbolTable: {
    upsertFile: () => {},
    removeFile: () => {},
    lookup: () => [],
    lookupByShortName: () => [],
    hasFile: () => false,
    hasFilesUnder: () => false,
    size: () => 0,
    hydrate: () => {},
    shortNameDefCounts: () => new Map(),
  },
  ...over,
});

// `agent.check` where `agent` is locally typed `Agent`, and Agent has subtypes
// overriding `check`. The cone fans `agent.check` out to the overriding
// subtypes (bd tea-rags-mcp-2jet / f10y).
const call: CallRef = { callText: "agent.check", receiver: "agent", member: "check", startLine: 1 };

const websiteTarget: SymbolResolutionTarget = {
  targetRelPath: "app/agents/website_agent.rb",
  targetSymbolId: "WebsiteAgent#check",
};
const twitterTarget: SymbolResolutionTarget = {
  targetRelPath: "app/agents/twitter_agent.rb",
  targetSymbolId: "TwitterAgent#check",
};
const baseTarget: SymbolResolutionTarget = {
  targetRelPath: "app/models/agent.rb",
  targetSymbolId: "Agent#check",
};

const sortEdges = (edges: DispatchEdge[]): DispatchEdge[] =>
  [...edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));

// bd f2jsb: resolveDispatch now returns DispatchFanoutOutcome; existing
// assertions target the edges payload, so unwrap (throwing on `ambiguous`
// keeps the assertion strict — these fixtures never exceed the fan-out cap).
const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

describe("ConeDispatchResolver", () => {
  it("returns [] when the receiver is null (bare call never cones)", () => {
    const resolver = new ConeDispatchResolver(locatorWith({ "WebsiteAgent#check": websiteTarget }), 8);
    const out = edgesOf(
      resolver.resolveDispatch(
        { callText: "check", receiver: null, member: "check", startLine: 1 },
        ctx({
          localBindings: { agent: [{ line: 1, type: "Agent" }] },
          hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }),
        }),
      ),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the receiver has no local binding (external never cones)", () => {
    const resolver = new ConeDispatchResolver(locatorWith({ "WebsiteAgent#check": websiteTarget }), 8);
    const out = edgesOf(resolver.resolveDispatch(call, ctx({ hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) })));
    expect(out).toEqual([]);
  });

  it("returns [] when no hierarchy view is wired", () => {
    const resolver = new ConeDispatchResolver(locatorWith({ "WebsiteAgent#check": websiteTarget }), 8);
    const out = edgesOf(
      resolver.resolveDispatch(call, ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] } })),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the bound type has no descendants (not polymorphic)", () => {
    const resolver = new ConeDispatchResolver(locatorWith({}), 8);
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({}) }),
      ),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when descendants exist but none override the member", () => {
    // WebsiteAgent is a descendant but the locator pins no direct method for it.
    const resolver = new ConeDispatchResolver(locatorWith({}), 8);
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({
          localBindings: { agent: [{ line: 1, type: "Agent" }] },
          hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }),
        }),
      ),
    );
    expect(out).toEqual([]);
  });

  it("fans out to N overriding subtypes with confidence 1/N and edgeKind 'cone' (|cone| ≤ K)", () => {
    const resolver = new ConeDispatchResolver(
      locatorWith({ "WebsiteAgent#check": websiteTarget, "TwitterAgent#check": twitterTarget }),
      8,
    );
    const out = sortEdges(
      edgesOf(
        resolver.resolveDispatch(
          call,
          ctx({
            localBindings: { agent: [{ line: 1, type: "Agent" }] },
            hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }),
          }),
        ),
      ),
    );
    expect(out).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/agents/twitter_agent.rb",
        targetSymbolId: "TwitterAgent#check",
        edgeKind: "cone",
        confidence: 0.5,
      },
      {
        sourceSymbolId: null,
        targetRelPath: "app/agents/website_agent.rb",
        targetSymbolId: "WebsiteAgent#check",
        edgeKind: "cone",
        confidence: 0.5,
      },
    ]);
  });

  it("collapses to a single poly-base edge to the base decl (T#m) when |cone| > K", () => {
    // K = 1 forces the >K branch with 2 overriding subtypes; base T#m is pinned.
    const resolver = new ConeDispatchResolver(
      locatorWith({
        "WebsiteAgent#check": websiteTarget,
        "TwitterAgent#check": twitterTarget,
        "Agent#check": baseTarget,
      }),
      1,
    );
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({
          localBindings: { agent: [{ line: 1, type: "Agent" }] },
          hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }),
        }),
      ),
    );
    expect(out).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/models/agent.rb",
        targetSymbolId: "Agent#check",
        edgeKind: "poly-base",
        confidence: 1,
      },
    ]);
  });

  it("falls back to a file-only poly-base edge when |cone| > K and T declares no direct method", () => {
    // T does not declare `check` directly (inherited / external), but its file
    // anchors query-time expansion — the engine composes the file-only edge.
    const resolver = new ConeDispatchResolver(
      locatorWith(
        { "WebsiteAgent#check": websiteTarget, "TwitterAgent#check": twitterTarget },
        { Agent: "app/models/agent.rb" },
      ),
      1,
    );
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({
          localBindings: { agent: [{ line: 1, type: "Agent" }] },
          hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }),
        }),
      ),
    );
    expect(out).toEqual([
      {
        sourceSymbolId: null,
        targetRelPath: "app/models/agent.rb",
        targetSymbolId: null,
        edgeKind: "poly-base",
        confidence: 1,
      },
    ]);
  });

  it("returns [] when |cone| > K and the base decl is unresolvable (no method, no file)", () => {
    const resolver = new ConeDispatchResolver(
      locatorWith({ "WebsiteAgent#check": websiteTarget, "TwitterAgent#check": twitterTarget }),
      1,
    );
    const out = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({
          localBindings: { agent: [{ line: 1, type: "Agent" }] },
          hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }),
        }),
      ),
    );
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RTA prune tests (bd tea-rags-mcp-pffv Task 4)
// ---------------------------------------------------------------------------

// Hierarchy: A, B, C all extend Base; each subtype `t` overrides `m` iff
// overriders.has(t). Base also defines `m` (the inherited fallback).
function buildRtaCtx(opts: { overriders: Set<string>; instantiated?: Set<string> }): {
  ctx: CallContext;
  locator: ConeTypeLocator;
} {
  const rows: InheritanceEdgeRow[] = ["A", "B", "C"].map((s, i) => ({
    sourceFqName: s,
    ancestorFqName: "Base",
    ancestorSymbolId: null,
    kind: "super",
    ordinal: i,
  }));
  const snapshot: HierarchySnapshot = {
    ancestorsBySource: { A: [rows[0]], B: [rows[1]], C: [rows[2]] },
    descendantsByAncestor: { Base: rows },
  };
  const rtaLocator: ConeTypeLocator = {
    resolveTypeFile: (t) => `${t.toLowerCase()}.rb`,
    findDirectMethod: (t, member): SymbolResolutionTarget | null =>
      member === "m" && (opts.overriders.has(t) || t === "Base")
        ? { targetRelPath: `${t.toLowerCase()}.rb`, targetSymbolId: `${t}#m` }
        : null,
  };
  const rtaCtx = {
    callerFile: "caller.rb",
    callerScope: [],
    imports: [],
    symbolTable: {} as never,
    localBindings: { obj: [{ line: 1, type: "Base" }] },
    hierarchy: new MapHierarchyView(snapshot),
    instantiatedTypes: opts.instantiated,
  } as unknown as CallContext;
  return { ctx: rtaCtx, locator: rtaLocator };
}

const rtaCall: CallRef = { receiver: "obj", member: "m", startLine: 1 } as CallRef;

describe("ConeDispatchResolver — RTA prune (bd pffv)", () => {
  it("prunes the cone to instantiated subtypes only", () => {
    const { ctx: rtaCtx, locator } = buildRtaCtx({
      overriders: new Set(["A", "B", "C"]),
      instantiated: new Set(["A"]),
    });
    const edges = edgesOf(new ConeDispatchResolver(locator, 8).resolveDispatch(rtaCall, rtaCtx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#m"]);
  });

  it("soundness floor: zero instantiation evidence keeps the full cone", () => {
    const { ctx: rtaCtx, locator } = buildRtaCtx({
      overriders: new Set(["A", "B", "C"]),
      instantiated: new Set(["Unrelated"]),
    });
    const edges = edgesOf(new ConeDispatchResolver(locator, 8).resolveDispatch(rtaCall, rtaCtx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#m", "B#m", "C#m"]);
  });

  it("gate: absent instantiatedTypes is byte-identical pre-pffv (full cone)", () => {
    const { ctx: rtaCtx, locator } = buildRtaCtx({ overriders: new Set(["A", "B", "C"]) });
    const edges = edgesOf(new ConeDispatchResolver(locator, 8).resolveDispatch(rtaCall, rtaCtx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#m", "B#m", "C#m"]);
  });

  it("drops a sibling whose nearest definer is the uninstantiated base", () => {
    // Only A overrides m; B,C inherit Base#m. Instantiate A and B.
    // A is live (definer A); B's nearest definer is Base (not in cone) ⇒ B's
    // cone slot does not exist (B doesn't override). Cone = {A} pre-prune,
    // stays {A}.
    const { ctx: rtaCtx, locator } = buildRtaCtx({
      overriders: new Set(["A"]),
      instantiated: new Set(["A", "B"]),
    });
    const edges = edgesOf(new ConeDispatchResolver(locator, 8).resolveDispatch(rtaCall, rtaCtx));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m"]);
  });
});

describe("ConeDispatchResolver — structural ancestors never define (bd 39xca.14)", () => {
  it("finds an instantiated type's nearest definer through nominal ancestors only", () => {
    // A and B extend Base and override m; Base does not define m. X extends Base
    // and defines nothing, but CONFORMS structurally to A. A structural ancestor
    // gives downward dispatch only, so X has no nearest definer: the RTA prune
    // finds no evidence and the soundness floor keeps the whole cone. Walking
    // the structural row would have kept A alone.
    const row = (source: string, ancestor: string, kind: InheritanceEdgeRow["kind"]): InheritanceEdgeRow => ({
      sourceFqName: source,
      sourceSymbolId: null,
      ancestorFqName: ancestor,
      ancestorSymbolId: null,
      kind,
      ordinal: 0,
    });
    const rows = [
      row("A", "Base", "super"),
      row("B", "Base", "super"),
      row("X", "Base", "super"),
      row("X", "A", "structural"),
    ];
    const snapshot: HierarchySnapshot = {
      ancestorsBySource: { A: [rows[0]], B: [rows[1]], X: [rows[2], rows[3]] },
      descendantsByAncestor: { Base: rows.slice(0, 3), A: [rows[3]] },
    };
    const locator: ConeTypeLocator = {
      resolveTypeFile: (t) => `${t.toLowerCase()}.ts`,
      findDirectMethod: (t, member): SymbolResolutionTarget | null =>
        member === "m" && (t === "A" || t === "B")
          ? { targetRelPath: `${t.toLowerCase()}.ts`, targetSymbolId: `${t}#m` }
          : null,
    };
    const structuralCtx = {
      callerFile: "caller.ts",
      callerScope: [],
      imports: [],
      symbolTable: {} as never,
      localBindings: { obj: [{ line: 1, type: "Base" }] },
      hierarchy: new MapHierarchyView(snapshot),
      instantiatedTypes: new Set(["X"]),
    } as unknown as CallContext;

    const edges = edgesOf(new ConeDispatchResolver(locator, 8).resolveDispatch(rtaCall, structuralCtx));

    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["A#m", "B#m"]);
  });
});

// ---------------------------------------------------------------------------
// bd tea-rags-mcp-m99j1.1.84 — the receiver's static class is itself a dispatch
// target. django `lookups = MultiValueDict(); lookups.appendlist(...)` emitted a
// 1-wide cone to the one subclass override (`QueryDict#appendlist`) and never
// the receiver's own `MultiValueDict#appendlist`. A language opts in by
// answering `ConeTypeLocator.isRuntimeDispatchClass`; without it the cone stays
// subtypes-only.
// ---------------------------------------------------------------------------

describe("ConeDispatchResolver — receiver declaration stays in the cone (bd m99j1.1.84)", () => {
  const row = (source: string, ancestor: string, kind: InheritanceEdgeRow["kind"]): InheritanceEdgeRow => ({
    sourceFqName: source,
    sourceSymbolId: null,
    ancestorFqName: ancestor,
    ancestorSymbolId: null,
    kind,
    ordinal: 0,
  });

  /** `Root <- Base <- {A, B}`, nominal unless `structuralOnly`. */
  function receiverCtx(opts: {
    definers: ReadonlySet<string>;
    instantiated?: ReadonlySet<string>;
    structuralOnly?: boolean;
    contracts?: ReadonlySet<string>;
    optedOut?: boolean;
  }): { ctx: CallContext; locator: ConeTypeLocator } {
    const kind: InheritanceEdgeRow["kind"] = opts.structuralOnly ? "structural" : "super";
    const rows = [row("A", "Base", kind), row("B", "Base", kind)];
    const rootRow = row("Base", "Root", "super");
    const snapshot: HierarchySnapshot = {
      ancestorsBySource: { A: [rows[0]], B: [rows[1]], Base: [rootRow] },
      descendantsByAncestor: { Base: rows, Root: [rootRow] },
    };
    const locator: ConeTypeLocator = {
      resolveTypeFile: (t) => `${t.toLowerCase()}.py`,
      findDirectMethod: (t, member): SymbolResolutionTarget | null =>
        member === "m" && opts.definers.has(t)
          ? { targetRelPath: `${t.toLowerCase()}.py`, targetSymbolId: `${t}#m` }
          : null,
      ...(opts.optedOut ? {} : { isRuntimeDispatchClass: (t: string) => !(opts.contracts ?? new Set()).has(t) }),
    };
    const context = {
      callerFile: "caller.py",
      callerScope: [],
      imports: [],
      symbolTable: {} as never,
      localBindings: { obj: [{ line: 1, type: "Base" }] },
      hierarchy: new MapHierarchyView(snapshot),
      instantiatedTypes: opts.instantiated,
    } as unknown as CallContext;
    return { ctx: context, locator };
  }

  const resolve = (c: { ctx: CallContext; locator: ConeTypeLocator }): DispatchEdge[] =>
    sortEdges(edgesOf(new ConeDispatchResolver(c.locator, 8).resolveDispatch(rtaCall, c.ctx)));

  it("keeps the receiver's own declaration beside the subclass override", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Base", "A"]) }));
    expect(edges.map((e) => [e.targetSymbolId, e.edgeKind, e.confidence])).toEqual([
      ["A#m", "cone", 0.5],
      ["Base#m", "cone", 0.5],
    ]);
  });

  it("keeps the declaration the receiver INHERITS from a nominal ancestor", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Root", "A"]) }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m", "Root#m"]);
  });

  it("adds nothing when no class on the receiver's MRO declares the member", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["A", "B"]) }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m", "B#m"]);
  });

  it("stays [] when no subtype overrides — the exact chain answers the receiver", () => {
    expect(resolve(receiverCtx({ definers: new Set(["Base"]) }))).toEqual([]);
  });

  it("never adds a structural contract's own declaration (a Protocol stub is no runtime target)", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Base", "A", "B"]), structuralOnly: true }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m", "B#m"]);
  });

  it("RTA keeps the declaration an instantiated non-overriding subtype dispatches to", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Base", "A"]), instantiated: new Set(["B"]) }));
    expect(edges.map((e) => [e.targetSymbolId, e.confidence])).toEqual([["Base#m", 1]]);
  });

  it("RTA prunes subclass overrides only — an instantiated receiver class keeps its own declaration", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Base", "A", "B"]), instantiated: new Set(["Base", "A"]) }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m", "Base#m"]);
  });

  it("never adds the declaration of a receiver the locator says is no runtime class (a Protocol)", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Base", "A"]), contracts: new Set(["Base"]) }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m"]);
  });

  it("never adds a stub the receiver inherits from a contract ancestor", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Root", "A"]), contracts: new Set(["Root"]) }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m"]);
  });

  it("does not count the receiver's declaration toward the cone cap", () => {
    const c = receiverCtx({ definers: new Set(["Base", "A", "B"]) });
    const edges = sortEdges(edgesOf(new ConeDispatchResolver(c.locator, 2).resolveDispatch(rtaCall, c.ctx)));
    expect(edges.map((e) => [e.targetSymbolId, e.edgeKind, e.confidence])).toEqual([
      ["A#m", "cone", 1 / 3],
      ["B#m", "cone", 1 / 3],
      ["Base#m", "cone", 1 / 3],
    ]);
  });

  it("a locator that does not answer isRuntimeDispatchClass keeps the cone subtypes-only", () => {
    const edges = resolve(receiverCtx({ definers: new Set(["Base", "A"]), optedOut: true }));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["A#m"]);
  });
});

// ---------------------------------------------------------------------------
// bd tea-rags-mcp-0qaht.64 — an OUT-OF-PROJECT receiver type extended by a
// project class. `class TreeContentHashes extends Map` overrides `get`, so
// every `counts.get(...)` on a plain `Map` became a 1-wide cone to
// `TreeContentHashes#get` (527 callers on tea-rags). The external class's own
// `get` is the runtime target the cone cannot emit, so the cone declines and
// the chain answers. A contract (`implements` only) has no runtime body of its
// own, so its implementers still cone.
// ---------------------------------------------------------------------------

describe("ConeDispatchResolver — out-of-project receiver type (bd 0qaht.64)", () => {
  const getTarget: SymbolResolutionTarget = {
    targetRelPath: "src/tree-content-hashes.ts",
    targetSymbolId: "TreeContentHashes#get",
  };
  const externalCtx = (kind: InheritanceEdge["kind"]): CallContext =>
    ctx({
      localBindings: { counts: [{ line: 1, type: "Map" }] },
      hierarchy: {
        getAncestors: () => [],
        getDescendants: (fqName: string): readonly InheritanceEdge[] =>
          fqName === "Map"
            ? [{ sourceFqName: "TreeContentHashes", ancestorFqName: "Map", ancestorSymbolId: null, kind, depth: 1 }]
            : [],
      },
    });
  const getCall: CallRef = { callText: "counts.get", receiver: "counts", member: "get", startLine: 1 };
  const locator = (projectTypes: ReadonlySet<string>): ConeTypeLocator => ({
    ...locatorWith({ "TreeContentHashes#get": getTarget }, { TreeContentHashes: "src/tree-content-hashes.ts" }),
    isProjectType: (typeName: string) => projectTypes.has(typeName),
  });

  it("declines a receiver whose type the project does not declare when a project class extends it", () => {
    const resolver = new ConeDispatchResolver(locator(new Set(["TreeContentHashes"])), 8);
    expect(edgesOf(resolver.resolveDispatch(getCall, externalCtx("super")))).toEqual([]);
  });

  it("still fans an out-of-project contract out to the project classes implementing it", () => {
    const resolver = new ConeDispatchResolver(locator(new Set(["TreeContentHashes"])), 8);
    const edges = edgesOf(resolver.resolveDispatch(getCall, externalCtx("implements")));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["TreeContentHashes#get"]);
  });

  it("keeps the cone for a receiver type the project declares", () => {
    const resolver = new ConeDispatchResolver(locator(new Set(["Map", "TreeContentHashes"])), 8);
    const edges = edgesOf(resolver.resolveDispatch(getCall, externalCtx("super")));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["TreeContentHashes#get"]);
  });
});

describe("ConeDispatchResolver — exact-construction receiver (bd 0qaht.66)", () => {
  const row = (source: string, ancestor: string): InheritanceEdgeRow => ({
    sourceFqName: source,
    sourceSymbolId: null,
    ancestorFqName: ancestor,
    ancestorSymbolId: null,
    kind: "super",
    ordinal: 0,
  });
  /** `Root <- Base <- {A, B}`; the `definers` declare `m`. */
  const snapshot: HierarchySnapshot = {
    ancestorsBySource: { A: [row("A", "Base")], B: [row("B", "Base")], Base: [row("Base", "Root")] },
    descendantsByAncestor: { Base: [row("A", "Base"), row("B", "Base")], Root: [row("Base", "Root")] },
  };
  const locator = (definers: ReadonlySet<string>): ConeTypeLocator => ({
    resolveTypeFile: (t) => `${t.toLowerCase()}.rb`,
    findDirectMethod: (t, member): SymbolResolutionTarget | null =>
      member === "m" && definers.has(t) ? { targetRelPath: `${t.toLowerCase()}.rb`, targetSymbolId: `${t}#m` } : null,
  });
  const callAt = (line: number): CallRef => ({ callText: "obj.m", receiver: "obj", member: "m", startLine: line });
  const resolve = (
    definers: ReadonlySet<string>,
    bindings: CallContext["localBindings"],
    constructedLocals?: CallContext["constructedLocals"],
  ): DispatchEdge[] =>
    edgesOf(
      new ConeDispatchResolver(locator(definers), 8).resolveDispatch(
        callAt(5),
        ctx({
          localBindings: bindings,
          hierarchy: new MapHierarchyView(snapshot),
          ...(constructedLocals ? { constructedLocals } : {}),
        }),
      ),
    );
  const constructedAtLine1 = { obj: [1] };

  it("resolves a constructed receiver to its own declaration, never a subclass override", () => {
    const edges = resolve(new Set(["Base", "A"]), { obj: [{ line: 1, type: "Base" }] }, constructedAtLine1);
    expect(edges).toEqual([
      { sourceSymbolId: null, targetRelPath: "base.rb", targetSymbolId: "Base#m", edgeKind: "exact", confidence: 1 },
    ]);
  });

  it("resolves a constructed receiver to the declaration it inherits from its nearest ancestor", () => {
    const edges = resolve(new Set(["Root", "A"]), { obj: [{ line: 1, type: "Base" }] }, constructedAtLine1);
    expect(edges.map((e) => [e.targetSymbolId, e.edgeKind])).toEqual([["Root#m", "exact"]]);
  });

  it("declines when no class on the constructed receiver's MRO declares the member", () => {
    expect(resolve(new Set(["A"]), { obj: [{ line: 1, type: "Base" }] }, constructedAtLine1)).toEqual([]);
  });

  it("keeps the cone for a declared (non-constructed) receiver type", () => {
    const edges = resolve(new Set(["Base", "A"]), { obj: [{ line: 1, type: "Base" }] });
    expect(edges.map((e) => [e.targetSymbolId, e.edgeKind])).toEqual([["A#m", "cone"]]);
  });

  it("keeps the cone once a later binding without the construction fact shadows it", () => {
    const bindings = {
      obj: [
        { line: 1, type: "Base" },
        { line: 3, type: "Base" },
      ],
    };
    const edges = resolve(new Set(["Base", "A"]), bindings, constructedAtLine1);
    expect(edges.map((e) => [e.targetSymbolId, e.edgeKind])).toEqual([["A#m", "cone"]]);
  });
});

describe("ConeDispatchResolver — structural descendant gate (bd iw702)", () => {
  const target = (owner: string): SymbolResolutionTarget => ({
    targetRelPath: `src/${owner.toLowerCase()}.ts`,
    targetSymbolId: `${owner}#get`,
  });
  const descendants: readonly [string, InheritanceEdge["kind"]][] = [
    ["Declared", "implements"],
    ["Fits", "structural"],
    ["Misfit", "structural"],
  ];
  /** `Port` has two structural descendants and one declared implementer. */
  const portCtx = (): CallContext =>
    ctx({
      localBindings: { port: [{ line: 1, type: "Port" }] },
      hierarchy: {
        getAncestors: () => [],
        getDescendants: (fqName: string): readonly InheritanceEdge[] =>
          fqName === "Port"
            ? descendants.map(([sourceFqName, kind]) => ({
                sourceFqName,
                ancestorFqName: "Port",
                ancestorSymbolId: null,
                kind,
                depth: 1,
              }))
            : [],
      },
    });
  const getCall: CallRef = { callText: "port.get", receiver: "port", member: "get", startLine: 1 };
  const baseLocator = locatorWith(Object.fromEntries(descendants.map(([owner]) => [`${owner}#get`, target(owner)])));

  it("drops a structural descendant the locator vetoes and never asks about a declared one", () => {
    const asked: string[] = [];
    const locator: ConeTypeLocator = {
      ...baseLocator,
      admitsStructuralDescendant: (descendant, baseType) => {
        asked.push(`${descendant}<:${baseType}`);
        return descendant !== "Misfit";
      },
    };
    const edges = edgesOf(new ConeDispatchResolver(locator, 8).resolveDispatch(getCall, portCtx()));
    expect(edges.map((e) => [e.targetSymbolId, e.confidence])).toEqual([
      ["Declared#get", 0.5],
      ["Fits#get", 0.5],
    ]);
    expect(asked).toEqual(["Fits<:Port", "Misfit<:Port"]);
  });

  /**
   * The gate only ever thins a cone the engine already ENUMERATES. Above the
   * cap the call stays the one `poly-base` edge it was: a descendant the
   * locator could not judge is kept for lack of evidence, not on proof, so
   * enumerating the survivors would swap a base edge for unproven targets.
   */
  it("keeps the poly-base edge of a cone that exceeded the cap before the veto", () => {
    const locator: ConeTypeLocator = {
      ...locatorWith(Object.fromEntries(descendants.map(([owner]) => [`${owner}#get`, target(owner)])), {
        Port: "src/port.ts",
      }),
      admitsStructuralDescendant: (descendant) => descendant !== "Misfit",
    };
    const edges = edgesOf(new ConeDispatchResolver(locator, 2).resolveDispatch(getCall, portCtx()));
    expect(edges.map((e) => [e.targetRelPath, e.targetSymbolId, e.edgeKind])).toEqual([
      ["src/port.ts", null, "poly-base"],
    ]);
  });

  it("keeps every structural descendant when the locator has no gate", () => {
    const edges = edgesOf(new ConeDispatchResolver(baseLocator, 8).resolveDispatch(getCall, portCtx()));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Declared#get", "Fits#get", "Misfit#get"]);
  });
});
