import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  HierarchyView,
  InheritanceEdge,
  SymbolResolutionTarget,
} from "../../../../src/core/contracts/types/codegraph.js";
import type { ConeTypeLocator } from "../../../../src/core/contracts/types/language.js";
import { ConeDispatchResolver } from "../../../../src/core/domains/language/cone-dispatch.js";

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

describe("ConeDispatchResolver", () => {
  it("returns [] when the receiver is null (bare call never cones)", () => {
    const resolver = new ConeDispatchResolver(locatorWith({ "WebsiteAgent#check": websiteTarget }), 8);
    const out = resolver.resolveDispatch(
      { callText: "check", receiver: null, member: "check", startLine: 1 },
      ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the receiver has no local binding (external never cones)", () => {
    const resolver = new ConeDispatchResolver(locatorWith({ "WebsiteAgent#check": websiteTarget }), 8);
    const out = resolver.resolveDispatch(call, ctx({ hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) }));
    expect(out).toEqual([]);
  });

  it("returns [] when no hierarchy view is wired", () => {
    const resolver = new ConeDispatchResolver(locatorWith({ "WebsiteAgent#check": websiteTarget }), 8);
    const out = resolver.resolveDispatch(call, ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] } }));
    expect(out).toEqual([]);
  });

  it("returns [] when the bound type has no descendants (not polymorphic)", () => {
    const resolver = new ConeDispatchResolver(locatorWith({}), 8);
    const out = resolver.resolveDispatch(
      call,
      ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({}) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when descendants exist but none override the member", () => {
    // WebsiteAgent is a descendant but the locator pins no direct method for it.
    const resolver = new ConeDispatchResolver(locatorWith({}), 8);
    const out = resolver.resolveDispatch(
      call,
      ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("fans out to N overriding subtypes with confidence 1/N and edgeKind 'cone' (|cone| ≤ K)", () => {
    const resolver = new ConeDispatchResolver(
      locatorWith({ "WebsiteAgent#check": websiteTarget, "TwitterAgent#check": twitterTarget }),
      8,
    );
    const out = sortEdges(
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
    const out = resolver.resolveDispatch(
      call,
      ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }) }),
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
    const out = resolver.resolveDispatch(
      call,
      ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }) }),
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
    const out = resolver.resolveDispatch(
      call,
      ctx({ localBindings: { agent: [{ line: 1, type: "Agent" }] }, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }) }),
    );
    expect(out).toEqual([]);
  });
});
