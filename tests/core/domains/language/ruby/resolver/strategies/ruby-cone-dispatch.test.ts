import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type HierarchyView,
  type InheritanceEdge,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  RubyConeDispatchResolver,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
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

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  ...over,
});

// `agent.check` where `agent` is locally typed `Agent`, and Agent has STI
// subclasses overriding `check`. The cone fans `agent.check` out to the
// overriding subclasses (bd tea-rags-mcp-2jet, variant A).
const call: CallRef = { callText: "agent.check", receiver: "agent", member: "check", startLine: 1 };

const agentBase: [string, NamedSymbol[]] = [
  "app/models/agent.rb",
  [sym("Agent", "Agent", "app/models/agent.rb", []), sym("Agent#check", "check", "app/models/agent.rb", ["Agent"])],
];
const website: [string, NamedSymbol[]] = [
  "app/agents/website_agent.rb",
  [
    sym("WebsiteAgent", "WebsiteAgent", "app/agents/website_agent.rb", []),
    sym("WebsiteAgent#check", "check", "app/agents/website_agent.rb", ["WebsiteAgent"]),
  ],
];
const twitter: [string, NamedSymbol[]] = [
  "app/agents/twitter_agent.rb",
  [
    sym("TwitterAgent", "TwitterAgent", "app/agents/twitter_agent.rb", []),
    sym("TwitterAgent#check", "check", "app/agents/twitter_agent.rb", ["TwitterAgent"]),
  ],
];

const sortEdges = (edges: DispatchEdge[]): DispatchEdge[] =>
  [...edges].sort((a, b) => (a.targetSymbolId ?? "").localeCompare(b.targetSymbolId ?? ""));

describe("RubyConeDispatchResolver", () => {
  const resolver = new RubyConeDispatchResolver(cfg);

  it("returns [] when the receiver is null (bare call never cones)", () => {
    const symbolTable = tableWith(agentBase, website);
    const out = resolver.resolveDispatch(
      { callText: "check", receiver: null, member: "check", startLine: 1 },
      ctx({ symbolTable, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when the receiver has no local binding (external never cones)", () => {
    const symbolTable = tableWith(agentBase, website);
    const out = resolver.resolveDispatch(
      call,
      ctx({ symbolTable, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when no hierarchy view is wired", () => {
    const symbolTable = tableWith(agentBase, website);
    const out = resolver.resolveDispatch(call, ctx({ symbolTable, localBindings: { agent: "Agent" } }));
    expect(out).toEqual([]);
  });

  it("returns [] when the bound type has no descendants (not polymorphic)", () => {
    const symbolTable = tableWith(agentBase);
    const out = resolver.resolveDispatch(
      call,
      ctx({ symbolTable, localBindings: { agent: "Agent" }, hierarchy: hierarchyWith({}) }),
    );
    expect(out).toEqual([]);
  });

  it("returns [] when descendants exist but none override the member", () => {
    // WebsiteAgent declared but does NOT define `check` → not in the cone.
    const symbolTable = tableWith(agentBase, [
      "app/agents/website_agent.rb",
      [sym("WebsiteAgent", "WebsiteAgent", "app/agents/website_agent.rb", [])],
    ]);
    const out = resolver.resolveDispatch(
      call,
      ctx({ symbolTable, localBindings: { agent: "Agent" }, hierarchy: hierarchyWith({ Agent: ["WebsiteAgent"] }) }),
    );
    expect(out).toEqual([]);
  });

  it("fans out to N overriding subtypes with confidence 1/N and edgeKind 'cone' (|cone| ≤ K)", () => {
    const symbolTable = tableWith(agentBase, website, twitter);
    const out = sortEdges(
      resolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { agent: "Agent" },
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

  it("collapses to a single poly-base edge to the base decl when |cone| > K", () => {
    const symbolTable = tableWith(agentBase, website, twitter);
    // K = 1 forces the >K branch with 2 overriding subtypes.
    const out = new RubyConeDispatchResolver({ ...cfg, coneMax: 1 }).resolveDispatch(
      call,
      ctx({
        symbolTable,
        localBindings: { agent: "Agent" },
        hierarchy: hierarchyWith({ Agent: ["WebsiteAgent", "TwitterAgent"] }),
      }),
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
});
