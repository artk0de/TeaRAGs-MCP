/**
 * bd tea-rags-mcp — DEFECT 2, slice 2d (provider-facing pure helpers).
 * Spec: docs/superpowers/specs/2026-07-06-ruby-self-receiver-dispatch-design.md.
 *
 * The provider wires the self-dispatch template discovery through three pure
 * adapters so the risky bits (self-call filtering, FQ-matched concrete-definition
 * lookup, multi-hook fold) are unit-testable free of the two-pass machinery:
 *   - extractSelfDispatchMethods(chunks) — per-method self-hook candidates.
 *   - buildSelfDispatchProbe(symbolTable, hierarchy) — the structural probe.
 *   - foldSelfDispatchTemplates(templates) — templates → run-global map (single-
 *     hook only; multi-hook deferred to the fan-out follow-up).
 */
import { describe, expect, it } from "vitest";

import type {
  ChunkExtraction,
  HierarchyView,
  InheritanceKind,
  NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  buildSelfDispatchProbe,
  collectSelfInstantiatingClassMethods,
  discoverSelfDispatchTemplates,
  extractSelfDispatchMethods,
  foldSelfDispatchTemplates,
  type SelfDispatchMethod,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

/** Minimal in-memory HierarchyView: canned descendants per fq, kind-filtered. */
const fakeHierarchy = (descendants: Record<string, { fq: string; kind: InheritanceKind }[]>): HierarchyView => ({
  getAncestors: () => [],
  getDescendants: (fq, opts) =>
    (descendants[fq] ?? [])
      .filter((d) => opts?.kinds === undefined || opts.kinds.includes(d.kind))
      .map((d) => ({ sourceFqName: d.fq, ancestorFqName: fq, ancestorSymbolId: null, kind: d.kind, depth: 1 })),
});

const chunk = (symbolId: string, scope: string[], calls: [string | null, string][]): ChunkExtraction => ({
  symbolId,
  scope,
  calls: calls.map(([receiver, member]) => ({ callText: `${receiver ?? ""}.${member}`, receiver, member, startLine: 1 })),
});

describe("extractSelfDispatchMethods", () => {
  it("captures self-shaped calls (bare / self / self.new / self.class.new), normalized to bare members", () => {
    const chunks: ChunkExtraction[] = [
      chunk("KindOfService.call", ["KindOfService"], [
        ["self.new", "perform"],
        ["self", "audit"],
        [null, "log"],
      ]),
    ];
    expect(extractSelfDispatchMethods(chunks)).toEqual([
      {
        symbolId: "KindOfService.call",
        enclosingType: "KindOfService",
        selfHookCandidates: ["perform", "audit", "log"],
      },
    ]);
  });

  it("captures implicit self-instantiation receivers (`new` / `new(args)` / `self.class.new`)", () => {
    const chunks: ChunkExtraction[] = [
      chunk("BaseService.call", ["BaseService"], [
        ["new", "perform"], // implicit self.new — walker emits receiver "new"
        ["new(args)", "run"], // implicit self.new(args)
        ["self.class.new", "process"],
      ]),
    ];
    expect(extractSelfDispatchMethods(chunks)).toEqual([
      {
        symbolId: "BaseService.call",
        enclosingType: "BaseService",
        selfHookCandidates: ["perform", "run", "process"],
      },
    ]);
  });

  it("ignores non-self receivers and methods with no self-calls", () => {
    const chunks: ChunkExtraction[] = [
      chunk("Foo#bar", ["Foo"], [["baz", "qux"], ["Other", "thing"]]), // no self-call → dropped
    ];
    expect(extractSelfDispatchMethods(chunks)).toEqual([]);
  });

  it("skips type-body chunks (DSL macros) — only method-shaped symbolIds are templates", () => {
    const chunks: ChunkExtraction[] = [
      chunk("Post", ["Post"], [[null, "has_many"], [null, "validates"]]), // class body, symbolId is the type
    ];
    expect(extractSelfDispatchMethods(chunks)).toEqual([]);
  });
});

describe("buildSelfDispatchProbe", () => {
  const table = (): InMemoryGlobalSymbolTable => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("app/services/create.rb", [sym("Create#perform", "perform", "app/services/create.rb", ["Create"])]);
    t.upsertFile("app/services/ns.rb", [sym("Ns::Deep#run", "run", "app/services/ns.rb", ["Ns", "Deep"])]);
    return t;
  };

  it("definesConcretely matches a method-level def by scope tail (bare and FQ type)", () => {
    const probe = buildSelfDispatchProbe(table(), undefined);
    expect(probe.definesConcretely("Create", "perform")).toBe(true);
    expect(probe.definesConcretely("KindOfService", "perform")).toBe(false); // absent hook
    expect(probe.definesConcretely("Ns::Deep", "run")).toBe(true); // FQ → bare tail "Deep"
  });

  it("relatedConcreteTypes returns transitive descendants across all four channels", () => {
    const hierarchy = fakeHierarchy({
      KindOfService: [
        { fq: "Create", kind: "include" },
        { fq: "Refresh", kind: "include" },
      ],
      Base: [{ fq: "Sub", kind: "super" }],
    });
    const probe = buildSelfDispatchProbe(table(), hierarchy);
    expect(probe.relatedConcreteTypes("KindOfService")).toEqual(["Create", "Refresh"]);
    expect(probe.relatedConcreteTypes("Unknown")).toEqual([]);
  });

  it("relatedConcreteTypes is empty when no hierarchy is present", () => {
    const probe = buildSelfDispatchProbe(table(), undefined);
    expect(probe.relatedConcreteTypes("KindOfService")).toEqual([]);
  });
});

describe("foldSelfDispatchTemplates", () => {
  it("folds single-hook templates into a symbolId → hook map", () => {
    expect(
      foldSelfDispatchTemplates([{ templateSymbolId: "KindOfService.call", enclosingType: "KindOfService", hook: "perform" }]),
    ).toEqual({ "KindOfService.call": "perform" });
  });

  it("EXCLUDES a template that reaches multiple distinct hooks (deferred to the fan-out follow-up)", () => {
    const map = foldSelfDispatchTemplates([
      { templateSymbolId: "BaseEvent#to_h", enclosingType: "BaseEvent", hook: "type" },
      { templateSymbolId: "BaseEvent#to_h", enclosingType: "BaseEvent", hook: "action" },
      { templateSymbolId: "KindOfService.call", enclosingType: "KindOfService", hook: "perform" },
    ]);
    // Multi-hook BaseEvent#to_h dropped (single-target strategy can't express a
    // fan-out); the single-hook template survives.
    expect(map).toEqual({ "KindOfService.call": "perform" });
  });
});

describe("collectSelfInstantiatingClassMethods (DEFECT 2 v2)", () => {
  it("includes a class-form method that self-instantiates (`new` self-hook)", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "KindOfService.call", enclosingType: "KindOfService", selfHookCandidates: ["new"] },
    ];
    expect(collectSelfInstantiatingClassMethods(methods)).toEqual(["KindOfService.call"]);
  });

  it("excludes an instance-form method (`Foo#bar`) even when it self-instantiates", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "KindOfService#call", enclosingType: "KindOfService", selfHookCandidates: ["new"] },
    ];
    expect(collectSelfInstantiatingClassMethods(methods)).toEqual([]);
  });

  it("excludes a class-form method that does not self-instantiate (no `new` self-hook)", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "KindOfService.call", enclosingType: "KindOfService", selfHookCandidates: ["perform", "audit"] },
    ];
    expect(collectSelfInstantiatingClassMethods(methods)).toEqual([]);
  });

  it("keeps only the class-form self-instantiating methods across a mixed batch", () => {
    const methods: SelfDispatchMethod[] = [
      { symbolId: "KindOfService.call", enclosingType: "KindOfService", selfHookCandidates: ["new"] },
      { symbolId: "KindOfService#call", enclosingType: "KindOfService", selfHookCandidates: ["perform"] },
      { symbolId: "OtherService.run", enclosingType: "OtherService", selfHookCandidates: ["new", "log"] },
      { symbolId: "NoNew.build", enclosingType: "NoNew", selfHookCandidates: ["assemble"] },
    ];
    expect(collectSelfInstantiatingClassMethods(methods)).toEqual(["KindOfService.call", "OtherService.run"]);
  });
});

describe("end-to-end: extract → probe → discover → fold (KindOfService shape)", () => {
  it("produces the KindOfService.call → perform run-global map", () => {
    const chunks: ChunkExtraction[] = [
      chunk("KindOfService.call", ["KindOfService"], [["self.new", "perform"]]),
    ];
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("app/services/kind_of_service.rb", [
      sym("KindOfService.call", "call", "app/services/kind_of_service.rb", ["KindOfService"]),
    ]);
    t.upsertFile("app/services/create.rb", [sym("Create#perform", "perform", "app/services/create.rb", ["Create"])]);
    const hierarchy = fakeHierarchy({ KindOfService: [{ fq: "Create", kind: "include" }] });

    const methods = extractSelfDispatchMethods(chunks);
    const probe = buildSelfDispatchProbe(t, hierarchy);
    const templates = discoverSelfDispatchTemplates(methods, probe);
    expect(foldSelfDispatchTemplates(templates)).toEqual({ "KindOfService.call": "perform" });
  });
});
