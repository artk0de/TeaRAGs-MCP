import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  HierarchyView,
  InheritanceEdge,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const tableWith = (
  ...files: [string, { symbolId: string; fqName: string; shortName: string; relPath: string; scope: string[] }[]][]
): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]) => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

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

/** Minimal HierarchyView: a flat descendants map keyed by fqName. */
function hierarchyOf(descendants: Record<string, string[]>): HierarchyView {
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
}

describe("RubyCallResolver.resolveDispatch — cone-first, then dynamic fan-out (wbj3 composition)", () => {
  const resolver = new RubyCallResolver();

  it("CONE WINS: a polymorphic typed receiver fans out to overriding subtypes (no dynamic edge)", () => {
    const symbolTable = tableWith(
      [
        "app/child_a.rb",
        [sym("ChildA", "ChildA", "app/child_a.rb", []), sym("ChildA#check", "check", "app/child_a.rb", ["ChildA"])],
      ],
      [
        "app/child_b.rb",
        [sym("ChildB", "ChildB", "app/child_b.rb", []), sym("ChildB#check", "check", "app/child_b.rb", ["ChildB"])],
      ],
    );
    const call: CallRef = { callText: "agent.check", receiver: "agent", member: "check", startLine: 1 };
    const edges = edgesOf(
      resolver.resolveDispatch(
        call,
        ctx({
          symbolTable,
          localBindings: { agent: [{ line: 1, type: "Agent" }] },
          hierarchy: hierarchyOf({ Agent: ["ChildA", "ChildB"] }),
        }),
      ),
    );
    expect(edges).toHaveLength(2);
    for (const e of edges) expect(e.edgeKind).toBe("cone");
  });

  // xlnub reconcile: unique survivor → confidence 1.0 (was discounted < 1)
  it("DYNAMIC FALLBACK: a unique untyped dynamic receiver fan-out narrows to one edge confidence 1.0", () => {
    const symbolTable = tableWith([
      "app/services/runner.rb",
      [sym("Runner#run", "run", "app/services/runner.rb", ["Runner"])],
    ]);
    const call: CallRef = { callText: "obj.run", receiver: "obj", member: "run", startLine: 1 };
    const edges = edgesOf(resolver.resolveDispatch(call, ctx({ symbolTable })));
    expect(edges).toHaveLength(1);
    expect(edges[0].edgeKind).toBe("dynamic");
    expect(edges[0].targetSymbolId).toBe("Runner#run");
    expect(edges[0].confidence).toBe(1.0);
  });

  it("returns [] for a constant receiver so the exact constant chain stays the default", () => {
    const symbolTable = tableWith(["app/models/user.rb", [sym("User.find", "find", "app/models/user.rb", ["User"])]]);
    const call: CallRef = { callText: "User.find", receiver: "User", member: "find", startLine: 1 };
    expect(edgesOf(resolver.resolveDispatch(call, ctx({ symbolTable })))).toEqual([]);
  });
});
