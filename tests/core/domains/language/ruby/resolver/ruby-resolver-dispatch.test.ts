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
    // `Agent` is a project class: an undeclared superclass reads as a library
    // class, whose own `check` the cone declines to bypass (bd 0qaht.64).
    const symbolTable = tableWith(
      ["app/agent.rb", [sym("Agent", "Agent", "app/agent.rb", [])]],
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

describe("RubyCallResolver — a `self.class` receiver in an instance method is the enclosing class (bd 2m83f.58)", () => {
  const resolver = new RubyCallResolver();
  const selfClass = (member: string, startLine = 5): CallRef => ({
    callText: `self.class.${member}`,
    receiver: "self.class",
    member,
    startLine,
  });
  const symbolTable = (() => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("lib/policy_error.rb", [
      sym("PolicyError", "PolicyError", "lib/policy_error.rb", []),
      sym("PolicyError.kind", "kind", "lib/policy_error.rb", ["PolicyError"]),
      sym("PolicyError#kind", "kind", "lib/policy_error.rb", ["PolicyError"]),
      sym("PolicyError.build", "build", "lib/policy_error.rb", ["PolicyError"]),
    ]);
    t.upsertFile("lib/forbidden_error.rb", [
      sym("ForbiddenError", "ForbiddenError", "lib/forbidden_error.rb", []),
      sym("ForbiddenError#details", "details", "lib/forbidden_error.rb", ["ForbiddenError"]),
    ]);
    t.upsertFile("lib/endpoint.rb", [
      sym("Endpoint", "Endpoint", "lib/endpoint.rb", []),
      sym("Endpoint#initialize", "initialize", "lib/endpoint.rb", ["Endpoint"]),
      sym("Endpoint#protagonist", "protagonist", "lib/endpoint.rb", ["Endpoint"]),
    ]);
    t.upsertFile("lib/admin_endpoint.rb", [
      sym("AdminEndpoint", "AdminEndpoint", "lib/admin_endpoint.rb", []),
      sym("AdminEndpoint#mirror", "mirror", "lib/admin_endpoint.rb", ["AdminEndpoint"]),
    ]);
    t.upsertFile("lib/kinded.rb", [
      { ...sym("Kinded", "Kinded", "lib/kinded.rb", []), symbolKind: "module" as const },
      sym("Kinded#describe", "describe", "lib/kinded.rb", ["Kinded"]),
    ]);
    return t;
  })();
  const classAncestors = { ForbiddenError: ["PolicyError"], AdminEndpoint: ["Endpoint"] };
  const inMethod = (callerSymbolId: string, scope: string[], file: string, hierarchy?: HierarchyView) =>
    ctx({ symbolTable, classAncestors, callerSymbolId, callerScope: scope, callerFile: file, hierarchy });

  it("`self.class.kind` lands on the class's singleton `kind`, not its instance namesake", () => {
    const target = resolver.resolve(
      selfClass("kind"),
      inMethod("PolicyError#kind", ["PolicyError"], "lib/policy_error.rb"),
    );
    expect(target).toEqual({ targetRelPath: "lib/policy_error.rb", targetSymbolId: "PolicyError.kind" });
  });

  it("a subclass's `self.class.kind` finds the singleton `kind` an ancestor declares", () => {
    const target = resolver.resolve(
      selfClass("kind"),
      inMethod("ForbiddenError#details", ["ForbiddenError"], "lib/forbidden_error.rb"),
    );
    expect(target?.targetSymbolId).toBe("PolicyError.kind");
  });

  it("`self.class.new(...)` lands on the class's `initialize`", () => {
    const target = resolver.resolve(
      { ...selfClass("new"), callText: "self.class.new('patch', path)" },
      inMethod("Endpoint#protagonist", ["Endpoint"], "lib/endpoint.rb"),
    );
    expect(target).toEqual({ targetRelPath: "lib/endpoint.rb", targetSymbolId: "Endpoint#initialize" });
  });

  it("`self.class.new` in a subclass reaches the `initialize` it inherits", () => {
    const target = resolver.resolve(
      selfClass("new"),
      inMethod("AdminEndpoint#mirror", ["AdminEndpoint"], "lib/admin_endpoint.rb"),
    );
    expect(target?.targetSymbolId).toBe("Endpoint#initialize");
  });

  it("`self.class.new` with no declared constructor takes the class's file-only edge, like `C.new`", () => {
    const target = resolver.resolve(
      selfClass("new"),
      inMethod("ForbiddenError#details", ["ForbiddenError"], "lib/forbidden_error.rb"),
    );
    expect(target).toEqual({ targetRelPath: "lib/forbidden_error.rb", targetSymbolId: null });
  });

  it("a core member the project never declares (`self.class.name`) stays external", () => {
    const at = inMethod("Endpoint#protagonist", ["Endpoint"], "lib/endpoint.rb");
    expect(resolver.resolve(selfClass("name"), at)).toBeNull();
    expect(resolver.targetsExternalImport(selfClass("name"), at)).toBe(true);
  });

  it("inside a class method `self.class` is `Class`, never the enclosing class", () => {
    const target = resolver.resolve(
      selfClass("kind"),
      inMethod("PolicyError.build", ["PolicyError"], "lib/policy_error.rb"),
    );
    expect(target?.targetSymbolId ?? null).not.toBe("PolicyError.kind");
  });

  it("inside a module's instance method `self.class` is the includer, so nothing is pinned", () => {
    const target = resolver.resolve(selfClass("kind"), inMethod("Kinded#describe", ["Kinded"], "lib/kinded.rb"));
    expect(target?.targetSymbolId ?? null).toBeNull();
  });

  it("fans `self.class.kind` out over the subclasses that redefine the singleton `kind`", () => {
    const overriding = new InMemoryGlobalSymbolTable();
    overriding.upsertFile("lib/policy_error.rb", [
      sym("PolicyError", "PolicyError", "lib/policy_error.rb", []),
      sym("PolicyError.kind", "kind", "lib/policy_error.rb", ["PolicyError"]),
      sym("PolicyError#kind", "kind", "lib/policy_error.rb", ["PolicyError"]),
    ]);
    overriding.upsertFile("lib/forbidden_error.rb", [
      sym("ForbiddenError", "ForbiddenError", "lib/forbidden_error.rb", []),
      sym("ForbiddenError.kind", "kind", "lib/forbidden_error.rb", ["ForbiddenError"]),
    ]);
    overriding.upsertFile("lib/missing_error.rb", [
      sym("MissingError", "MissingError", "lib/missing_error.rb", []),
      sym("MissingError#kind", "kind", "lib/missing_error.rb", ["MissingError"]),
    ]);
    const at = ctx({
      symbolTable: overriding,
      classAncestors: { ForbiddenError: ["PolicyError"], MissingError: ["PolicyError"] },
      callerSymbolId: "PolicyError#kind",
      callerScope: ["PolicyError"],
      callerFile: "lib/policy_error.rb",
      hierarchy: hierarchyOf({ PolicyError: ["ForbiddenError", "MissingError"] }),
    });
    const edges = edgesOf(resolver.resolveDispatch(selfClass("kind"), at));
    expect(edges.map((e) => [e.targetSymbolId, e.edgeKind]).sort()).toEqual([
      ["ForbiddenError.kind", "cone"],
      ["PolicyError.kind", "cone"],
    ]);
  });

  it("no cone when no subclass redefines the singleton member", () => {
    const at = inMethod(
      "PolicyError#kind",
      ["PolicyError"],
      "lib/policy_error.rb",
      hierarchyOf({ PolicyError: ["ForbiddenError"] }),
    );
    expect(edgesOf(resolver.resolveDispatch(selfClass("kind"), at))).toEqual([]);
  });
});
