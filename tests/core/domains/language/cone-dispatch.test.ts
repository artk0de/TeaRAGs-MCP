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
} from "../../../../src/core/contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../src/core/contracts/types/language.js";
import { ConeDispatchResolver } from "../../../../src/core/domains/language/cone-dispatch.js";
import { MapHierarchyView } from "../../../../src/core/infra/graph/hierarchy-view.js";

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
