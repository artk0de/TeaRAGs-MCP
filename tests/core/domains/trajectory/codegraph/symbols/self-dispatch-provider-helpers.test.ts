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
  SymbolDefinition,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import {
  buildSelfDispatchProbe,
  collectSelfInstantiatingClassMethods,
  deriveServiceEntryReturnTypes,
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
  calls: calls.map(([receiver, member]) => ({
    callText: `${receiver ?? ""}.${member}`,
    receiver,
    member,
    startLine: 1,
  })),
});

describe("extractSelfDispatchMethods", () => {
  it("captures self-shaped calls (bare / self / self.new / self.class.new), normalized to bare members", () => {
    const chunks: ChunkExtraction[] = [
      chunk(
        "KindOfService.call",
        ["KindOfService"],
        [
          ["self.new", "perform"],
          ["self", "audit"],
          [null, "log"],
        ],
      ),
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
      chunk(
        "BaseService.call",
        ["BaseService"],
        [
          ["new", "perform"], // implicit self.new — walker emits receiver "new"
          ["new(args)", "run"], // implicit self.new(args)
          ["self.class.new", "process"],
        ],
      ),
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
      chunk(
        "Foo#bar",
        ["Foo"],
        [
          ["baz", "qux"],
          ["Other", "thing"],
        ],
      ), // no self-call → dropped
    ];
    expect(extractSelfDispatchMethods(chunks)).toEqual([]);
  });

  it("skips type-body chunks (DSL macros) — only method-shaped symbolIds are templates", () => {
    const chunks: ChunkExtraction[] = [
      chunk(
        "Post",
        ["Post"],
        [
          [null, "has_many"],
          [null, "validates"],
        ],
      ), // class body, symbolId is the type
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

// bd tea-rags-mcp-bcdfe — the abstract-stub half of the abstract-in-A predicate.
// `definesConcretely` must answer "a CONCRETE body exists", not merely "a def
// exists": a walker-marked stub (`raise NotImplementedError` / empty / bare
// `super`) is a declaration, so the hook stays abstract in its declaring type and
// the REDIRECT terminal becomes reachable.
describe("buildSelfDispatchProbe — abstract stubs are not concrete definitions (bcdfe)", () => {
  const def = (
    symbolId: string,
    shortName: string,
    relPath: string,
    scope: string[],
    isAbstractStub?: true,
  ): SymbolDefinition => ({
    symbolId,
    fqName: symbolId,
    shortName,
    relPath,
    scope,
    ...(isAbstractStub === true ? { isAbstractStub: true } : {}),
  });

  // The spec's `ApplicationCsvExporter` witness: the base DECLARES `build` as a
  // `raise NotImplementedError` stub; the concrete exporter overrides it.
  const EXPORTER_FILE = "app/exporters/application_csv_exporter.rb";
  const FOO_FILE = "app/exporters/foo_exporter.rb";

  const exporterTable = (fooOverrideIsStub = false): InMemoryGlobalSymbolTable => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile(EXPORTER_FILE, [
      def("ApplicationCsvExporter#export", "export", EXPORTER_FILE, ["ApplicationCsvExporter"]),
      def("ApplicationCsvExporter#build", "build", EXPORTER_FILE, ["ApplicationCsvExporter"], true),
    ]);
    t.upsertFile(FOO_FILE, [
      def("FooExporter#build", "build", FOO_FILE, ["FooExporter"], fooOverrideIsStub ? true : undefined),
    ]);
    return t;
  };

  it("definesConcretely is FALSE for a def the walker marked as an abstract stub", () => {
    const probe = buildSelfDispatchProbe(exporterTable(), undefined);
    expect(probe.definesConcretely("ApplicationCsvExporter", "build")).toBe(false);
    expect(probe.definesConcretely("FooExporter", "build")).toBe(true); // real override
  });

  it("discovers the REDIRECT template: base hook is a STUB, a subtype overrides it concretely", () => {
    const methods: SelfDispatchMethod[] = [
      {
        symbolId: "ApplicationCsvExporter#export",
        enclosingType: "ApplicationCsvExporter",
        selfHookCandidates: ["build"],
      },
    ];
    const hierarchy = fakeHierarchy({ ApplicationCsvExporter: [{ fq: "FooExporter", kind: "super" }] });
    const templates = discoverSelfDispatchTemplates(methods, buildSelfDispatchProbe(exporterTable(), hierarchy));
    expect(templates).toEqual([
      { templateSymbolId: "ApplicationCsvExporter#export", enclosingType: "ApplicationCsvExporter", hook: "build" },
    ]);
  });

  it("discovers NOTHING when every override is itself a stub (no concrete definer anywhere)", () => {
    const methods: SelfDispatchMethod[] = [
      {
        symbolId: "ApplicationCsvExporter#export",
        enclosingType: "ApplicationCsvExporter",
        selfHookCandidates: ["build"],
      },
    ];
    const hierarchy = fakeHierarchy({ ApplicationCsvExporter: [{ fq: "FooExporter", kind: "super" }] });
    const templates = discoverSelfDispatchTemplates(methods, buildSelfDispatchProbe(exporterTable(true), hierarchy));
    expect(templates).toEqual([]);
  });
});

describe("foldSelfDispatchTemplates", () => {
  it("folds single-hook templates into a symbolId → hook map", () => {
    expect(
      foldSelfDispatchTemplates([
        { templateSymbolId: "KindOfService.call", enclosingType: "KindOfService", hook: "perform" },
      ]),
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

// ---------------------------------------------------------------------------
// bd tea-rags-mcp-j9xpf — service-entry RETURN threading.
//
// The walker types the SHARED template's return (`KindOfService#call` →
// `KindOfService::Result`) but every real call site names a CONCRETE entry
// (`Billing::X::Create.call`). The barrier owns the join: for each entry the
// self-dispatch discovery already classifies, re-key the template's return fact
// onto every concrete type wired to it, so the consumption path sees the fact at
// the coordinate it actually looks up. DERIVED — never overrides a declared fact.
// ---------------------------------------------------------------------------
describe("deriveServiceEntryReturnTypes (j9xpf)", () => {
  const RESULT: RubyTypeRef = { form: "instance", name: "KindOfService::Result" };
  const related = (map: Record<string, string[]>) => (type: string) => map[type] ?? [];

  it("re-keys the template's return fact onto every concrete entry (class-form entry)", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT },
      related({ KindOfService: ["Billing::Create", "Billing::Refresh"] }),
    );
    expect(derived).toEqual({ "Billing::Create#call": RESULT, "Billing::Refresh#call": RESULT });
  });

  it("re-keys from an INSTANCE-form template symbolId too", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService#call"],
      { "KindOfService#call": RESULT },
      related({ KindOfService: ["Billing::Create"] }),
    );
    expect(derived).toEqual({ "Billing::Create#call": RESULT });
  });

  it("SILENCE when the template itself has no return fact (nothing to thread)", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      {},
      related({ KindOfService: ["Billing::Create"] }),
    );
    expect(derived).toEqual({});
  });

  it("SILENCE when no concrete type is wired to the template", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT },
      related({}),
    );
    expect(derived).toEqual({});
  });

  it("NEVER overrides a DECLARED fact at the entry coordinate (YARD / associations / body-last-expr win)", () => {
    const declared: RubyTypeRef = { form: "instance", name: "Billing::CreateResult" };
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT, "Billing::Create#call": declared },
      related({ KindOfService: ["Billing::Create", "Billing::Refresh"] }),
    );
    expect(derived["Billing::Create#call"]).toBeUndefined();
    expect(derived["Billing::Refresh#call"]).toEqual(RESULT);
  });

  it("threads the ENTRY's own member name, not a fixed `call`", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["BaseProcessor.process_result"],
      { "BaseProcessor#process_result": RESULT },
      related({ BaseProcessor: ["CsvProcessor"] }),
    );
    expect(derived).toEqual({ "CsvProcessor#process_result": RESULT });
  });

  it("ignores a symbolId with no method separator (a type-body chunk)", () => {
    expect(
      deriveServiceEntryReturnTypes(
        ["KindOfService"],
        { "KindOfService#call": RESULT },
        related({ KindOfService: ["X"] }),
      ),
    ).toEqual({});
  });

  it("first entry channel wins when two templates derive the same coordinate (deterministic, no flip-flop)", () => {
    const other: RubyTypeRef = { form: "instance", name: "Other::Result" };
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call", "OtherBase.call"],
      { "KindOfService#call": RESULT, "OtherBase#call": other },
      related({ KindOfService: ["Shared"], OtherBase: ["Shared"] }),
    );
    expect(derived["Shared#call"]).toEqual(RESULT);
  });

  // ── two-coordinate TEMPLATE lookup (bd z5gqv) ─────────────────────────────
  //
  // The template symbolId carries its own form. A `.`-form template names a
  // CLASS method, so the `.` coordinate is the one a class receiver reads first
  // — `declaredReturnTypeOn`'s rule, restated on the write side. The `#`
  // fallback stays, because that is where every fact is keyed today, and the
  // yt3im existence gate applies to the `.` reading too: a fact naming a type
  // the project declares nowhere is not evidence and must not be threaded.

  it("a CLASS-form template reads its `.` coordinate first", () => {
    const classLevel: RubyTypeRef = { form: "instance", name: "KindOfService::ClassResult" };
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService.call": classLevel, "KindOfService#call": RESULT },
      related({ KindOfService: ["Billing::Create"] }),
      () => true,
    );
    expect(derived["Billing::Create#call"]).toEqual(classLevel);
  });

  it("a CLASS-form template falls back to `#` when no `.` twin exists", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT },
      related({ KindOfService: ["Billing::Create"] }),
      () => true,
    );
    expect(derived["Billing::Create#call"]).toEqual(RESULT);
  });

  it("a `.`-keyed FICTION does not outrank the `#` fact it shadows", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService.call": { form: "instance", name: "ServiceResult" }, "KindOfService#call": RESULT },
      related({ KindOfService: ["Billing::Create"] }),
      (name) => name === "KindOfService::Result",
    );
    expect(derived["Billing::Create#call"]).toEqual(RESULT);
  });

  it("an INSTANCE-form template never reads the `.` coordinate", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService#call"],
      { "KindOfService.call": { form: "instance", name: "KindOfService::ClassResult" } },
      related({ KindOfService: ["Billing::Create"] }),
      () => true,
    );
    expect(derived).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// bd tea-rags-mcp-yt3im — EXISTENCE-GATED precedence over declared facts.
//
// `@!method self.call` directives own the `Entry.call` (class-form) coordinate
// (bd 8ypeu) and `declaredReturnTypeOn` reads that form FIRST for a class
// receiver. On taxdome 251 of those directives declare `@return [ServiceResult]`
// — a class the corpus declares NOWHERE. The fiction outranked the derivation
// that names the real `KindOfService::Result`, and the derive's skip-guard never
// saw the collision because it only ever inspected the `#` sibling.
//
// The rule these cases pin: a DECLARED fact keeps its coordinate as long as it
// names a type the project actually declares. A fact naming nothing is not
// evidence, so a derived fact at the same coordinate takes it — including the
// class-form coordinate, whose OWNERSHIP is unchanged (still class-form, still
// what a class receiver reads first) even when its VALUE is replaced.
// ---------------------------------------------------------------------------
describe("deriveServiceEntryReturnTypes — existence-gated precedence (yt3im)", () => {
  const RESULT: RubyTypeRef = { form: "instance", name: "KindOfService::Result" };
  const related = (map: Record<string, string[]>) => (type: string) => map[type] ?? [];
  /** The corpus declares `KindOfService::Result` and `Billing::CreateResult`; nothing else. */
  const declares = (name: string): boolean => name === "KindOfService::Result" || name === "Billing::CreateResult";

  it("REPLACES a class-form fact whose type the project declares nowhere", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      {
        "KindOfService#call": RESULT,
        "Billing::Create.call": { form: "instance", name: "ServiceResult" },
      },
      related({ KindOfService: ["Billing::Create"] }),
      declares,
    );
    // Both coordinates carry the real type: the `#` one for instance receivers,
    // the `.` one because a class receiver reads it FIRST.
    expect(derived["Billing::Create.call"]).toEqual(RESULT);
    expect(derived["Billing::Create#call"]).toEqual(RESULT);
  });

  it("LEAVES a class-form fact whose type IS declared in-project (8ypeu ownership intact)", () => {
    const declaredClassForm: RubyTypeRef = { form: "instance", name: "Billing::CreateResult" };
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT, "Billing::Create.call": declaredClassForm },
      related({ KindOfService: ["Billing::Create"] }),
      declares,
    );
    expect(derived["Billing::Create.call"]).toBeUndefined();
  });

  it("REPLACES an instance-form fact whose type the project declares nowhere", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT, "Billing::Create#call": { form: "instance", name: "ServiceResult" } },
      related({ KindOfService: ["Billing::Create"] }),
      declares,
    );
    expect(derived["Billing::Create#call"]).toEqual(RESULT);
  });

  it("never replaces a NON-NOMINAL declared fact — a union/container names no single class to check", () => {
    const union: RubyTypeRef = {
      form: "union",
      members: [{ form: "instance", name: "Nope" }, RESULT],
    };
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT, "Billing::Create#call": union },
      related({ KindOfService: ["Billing::Create"] }),
      declares,
    );
    expect(derived["Billing::Create#call"]).toBeUndefined();
  });

  it("derives NOTHING at a fictional class-form coordinate when the template has no fact to thread", () => {
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "Billing::Create.call": { form: "instance", name: "ServiceResult" } },
      related({ KindOfService: ["Billing::Create"] }),
      declares,
    );
    expect(derived).toEqual({});
  });

  it("with NO existence oracle every declared fact is taken at face value (legacy behaviour)", () => {
    const fiction: RubyTypeRef = { form: "instance", name: "ServiceResult" };
    const derived = deriveServiceEntryReturnTypes(
      ["KindOfService.call"],
      { "KindOfService#call": RESULT, "Billing::Create#call": fiction, "Billing::Create.call": fiction },
      related({ KindOfService: ["Billing::Create"] }),
    );
    expect(derived).toEqual({});
  });
});

describe("end-to-end: extract → probe → discover → fold (KindOfService shape)", () => {
  it("produces the KindOfService.call → perform run-global map", () => {
    const chunks: ChunkExtraction[] = [chunk("KindOfService.call", ["KindOfService"], [["self.new", "perform"]])];
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
