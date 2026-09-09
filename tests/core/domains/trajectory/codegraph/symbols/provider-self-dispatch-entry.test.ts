/**
 * bd tea-rags-mcp — DEFECT 2 (self-receiver abstract-hook dispatch), e2e.
 * Spec: docs/superpowers/specs/2026-07-06-ruby-self-receiver-dispatch-design.md.
 *
 * End-to-end through the REAL provider two-pass (walker → extraction → pass-1
 * self-dispatch accumulation → pass-1→pass-2 barrier discovery → ctx thread →
 * entry strategy). Faithful reproduction of the taxdome recall hole: a shared
 * class-method template `KindOfService.call` dispatches to a `perform` hook on a
 * fresh instance of self (`new.perform`), inherited by MANY concrete services
 * that each define `#perform`. `KindOfService` never defines `perform`.
 *
 * With enough concrete definers the template body's own `new.perform` (an untyped
 * `new` receiver) fans out OVER the dispatch cap → the K-cap suppresses it to an
 * aggregate with ZERO edges, so `get_callers(Service0#perform)` would be `[]`
 * (the reported hole). The entry-anchored mechanism must, at each concrete entry
 * `Service0.call`, narrow to exactly `Service0#perform` — the SOLE, precise edge
 * that closes the hole. Narrow-to-1: `Service1.call` → `Service1#perform`, never
 * a cone across both. Guards FQ alignment across walker/accumulator/barrier/
 * strategy that unit tests (which inject hand-built maps) cannot catch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DISPATCH_FANOUT_CAP_FLOOR } from "../../../../../../src/core/domains/language/kernel/fanout-policy.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

// Concrete services > the fan-out cap floor so the template body's `new.perform`
// goes over-cap (suppressed to an aggregate, 0 edges) — the taxdome hole.
const SERVICE_COUNT = DISPATCH_FANOUT_CAP_FLOOR + 2; // 18 > 16

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — entry-anchored self-dispatch (DEFECT 2)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    // Shared class-method template: `self.call` instantiates self and dispatches
    // to the abstract `perform` hook (`new.perform` — implicit self.new). The
    // template's own type never defines `perform`.
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      ["class KindOfService", "  def self.call", "    new.perform", "  end", "end", ""].join("\n"),
    );
    paths.push("src/kind_of_service.rb");
    // SERVICE_COUNT concrete services inherit the class-method template and each
    // define the concrete `#perform`. Fillers give every class distinct extra
    // short-names so the corpus p99 candidate-count stays 1 → the cap holds at
    // the floor and `perform` (SERVICE_COUNT defs) is genuinely over-cap.
    for (let i = 0; i < SERVICE_COUNT; i++) {
      const fillers = Array.from({ length: 6 }, (_, j) => `  def filler_${i}_${j}\n  end\n`).join("");
      // `#perform` carries a real body — an EMPTY body is an abstract stub
      // (bd tea-rags-mcp-bcdfe), which is a declaration, not a concrete definer.
      writeFileSync(
        join(root, "src", `service_${i}.rb`),
        `class Service${i} < KindOfService\n  def perform\n    :done\n  end\n${fillers}end\n`,
      );
      paths.push(`src/service_${i}.rb`);
    }
    // Caller: two distinct concrete entries through the same shared template.
    writeFileSync(
      join(root, "src", "things_controller.rb"),
      [
        "class ThingsController",
        "  def create",
        "    Service0.call",
        "  end",
        "  def refresh",
        "    Service1.call",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/things_controller.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-self-dispatch-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-self-dispatch-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("narrows each concrete entry `Const.call` to its own `Const#perform`, the SOLE edge (over-cap hole closed)", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

    // ── Entry-anchored narrow-to-1: each caller reaches ITS OWN concrete hook.
    expect(edges).toContainEqual({
      source_symbol_id: "ThingsController#create",
      target_symbol_id: "Service0#perform",
      call_expression: "Service0.call",
    });
    expect(edges).toContainEqual({
      source_symbol_id: "ThingsController#refresh",
      target_symbol_id: "Service1#perform",
      call_expression: "Service1.call",
    });

    // ── Recall-critical: the template body's `new.perform` fan-out is over-cap
    // (suppressed, 0 edges), so the entry edge is the SOLE path to Service0#perform.
    // get_callers(Service0#perform) === [ThingsController#create]. This is the
    // taxdome `[]` hole, closed — and it is NOT a cone (exactly one target).
    const service0Callers = edges.filter((e) => e.target_symbol_id === "Service0#perform");
    expect(service0Callers).toHaveLength(1);
    expect(service0Callers[0].source_symbol_id).toBe("ThingsController#create");

    // ── Bypass: the entry edge lands on the concrete hook, NOT the shared
    // template node — `Service0.call` does not also record an edge to KindOfService.call.
    const toTemplate = edges.filter(
      (e) => e.target_symbol_id === "KindOfService.call" && e.call_expression.endsWith(".call"),
    );
    expect(toTemplate).toHaveLength(0);
  });
});

// DEFECT 2 v2: the REAL taxdome KindOfService shape is TWO hops via a self-instance
// LOCAL VAR. The CLASS method `self.call` self-instantiates and delegates to the
// SAME-named INSTANCE method (`instance = new; instance.call`); the INSTANCE method
// `#call` is the self-dispatch template that self-calls the abstract `perform` hook.
// v1 misses because the class method's only self-hook is `new` (the `instance.call`
// delegation is on a local var, not captured), so the class method is NOT a template.
// v2 bridges: entry `Create.call` → class method `KindOfService.call` (a known
// self-instantiating delegator) → same-named instance template `KindOfService#call`
// (hook perform) → concrete `Create#perform`.
describe("CodegraphEnrichmentProvider — self-instance delegation entry (DEFECT 2 v2)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    // Shared service module-as-class: the CLASS method `self.call` self-instantiates
    // and delegates to the SAME-named INSTANCE method via a local var; the INSTANCE
    // method `call` self-calls the abstract `perform` hook. `KindOfService` never
    // defines `perform`.
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      [
        "class KindOfService",
        "  def self.call",
        "    instance = new",
        "    instance.call",
        "  end",
        "  def call",
        "    perform",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/kind_of_service.rb");
    // Concrete subclass defines the `#perform` hook (via `<` so classAncestors
    // carries it) with a REAL body — an empty body would be an abstract stub.
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    paths.push("src/create.rb");
    // Caller: a concrete entry through the shared self-instantiating class method.
    writeFileSync(join(root, "src", "c.rb"), ["class C", "  def go", "    Create.call", "  end", "end", ""].join("\n"));
    paths.push("src/c.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-self-dispatch-v2-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-self-dispatch-v2-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("bridges the class→instance self-delegation: `C#go` reaches the concrete `Create#perform`", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

    // The entry-anchored recall win: the KindOfService chain fires end-to-end,
    // so `get_callers(Create#perform)` includes `C#go` (was `[]` in v1).
    expect(edges).toContainEqual({
      source_symbol_id: "C#go",
      target_symbol_id: "Create#perform",
      call_expression: "Create.call",
    });
  });
});

// bd tea-rags-mcp-bcdfe + tea-rags-mcp-wceck — the REDIRECT terminal. The base does
// NOT merely omit the hook: it DECLARES it as a `raise NotImplementedError` stub,
// and concrete subtypes override it (the spec's `ApplicationCsvExporter` /
// `BaseProcessor` witnesses, whose graph state was "edge → abstract stub"). Before
// the walker stub flag, that declaration read as a concrete definition, so no
// template was discovered at all. Two invariants, both entry-anchored: an entry
// whose constant OVERRIDES the stub reaches its own concrete `Const#hook`; an entry
// whose constant does NOT override it emits NO edge to the inherited stub.
describe("CodegraphEnrichmentProvider — abstract-stub REDIRECT terminal (bcdfe/wceck)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    // Shared base: a class-method template dispatching to `process_result` on a
    // fresh instance of self, and an ABSTRACT STUB declaration of that hook.
    writeFileSync(
      join(root, "src", "base_processor.rb"),
      [
        "class BaseProcessor",
        "  def self.process",
        "    new.process_result",
        "  end",
        "  def process_result",
        "    raise NotImplementedError",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/base_processor.rb");
    // Concrete subtype: overrides the hook with a real body.
    writeFileSync(
      join(root, "src", "form_1040.rb"),
      ["class Form1040 < BaseProcessor", "  def process_result", "    persist_rows", "  end", "end", ""].join("\n"),
    );
    paths.push("src/form_1040.rb");
    // Non-overriding subtype: inherits the stub untouched.
    writeFileSync(
      join(root, "src", "plain_processor.rb"),
      ["class PlainProcessor < BaseProcessor", "  def label", '    "plain"', "  end", "end", ""].join("\n"),
    );
    paths.push("src/plain_processor.rb");
    // Caller: one entry through each subtype.
    writeFileSync(
      join(root, "src", "runner.rb"),
      [
        "class Runner",
        "  def go",
        "    Form1040.process",
        "  end",
        "  def go_plain",
        "    PlainProcessor.process",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/runner.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-stub-redirect-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-stub-redirect-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("REDIRECTs the entry past the base's stub to the concrete override, and never edges to the stub", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

    // ── REDIRECT: the entry reaches the concrete override. The stub declaration
    // in the base no longer masks the hook (pre-flag, no template was discovered
    // at all and this edge did not exist).
    expect(edges).toContainEqual({
      source_symbol_id: "Runner#go",
      target_symbol_id: "Form1040#process_result",
      call_expression: "Form1040.process",
    });

    // ── GUARD: the non-overriding entry must NOT edge to the inherited stub —
    // a declaration is not a call target.
    const plainToStub = edges.filter(
      (e) => e.source_symbol_id === "Runner#go_plain" && e.target_symbol_id === "BaseProcessor#process_result",
    );
    expect(plainToStub).toHaveLength(0);

    // ── And the overriding entry never lands on the stub either.
    const goToStub = edges.filter(
      (e) => e.source_symbol_id === "Runner#go" && e.target_symbol_id === "BaseProcessor#process_result",
    );
    expect(goToStub).toHaveLength(0);
  });
});

// bd tea-rags-mcp-znxg8 — entry-call recall collapse on an INCREMENTAL run.
//
// Field report (taxdome, `code_27622aef`): `get_callers` for a plain service
// returns roughly half its real callers; the rest land on the shared mixin entry
// `KindOfService.call` (file-level fanIn 2324, `isHub: true`). Sampling 200
// caller edges of that node — 200/200 are concrete `SomeService.call(...)` entry
// calls, not one a genuine call of the mixin's own method. The seven call sites
// of ONE service resolved three different ways, and the only thing that varied
// between them was WHICH enrichment run walked the caller's file.
//
// The asymmetry that produces it: `GlobalSymbolTable` IS hydrated from
// `cg_symbols` when the collection opens (codegraph/factory.ts `initHook`), so
// cross-file DEFINITION lookups survive an incremental run — but
// `CodegraphRunState.selfDispatchMethods` and `.inheritanceRows` are built ONLY
// from files walked in the current batch (extraction-sink.ts `write`). A batch
// that does not include the template's own file therefore seals a registry
// without `KindOfService#call` in it, the entry strategy CONTINUEs, and
// `RubyConstantSymbolResolutionStrategy`'s ancestor walk degrades the entry onto
// the shared template node.
//
// Modelled exactly: run 1 walks the whole corpus (the registry is complete), run
// 2 re-walks ONLY the caller — the shape of every incremental reindex. The
// provider keeps its symbol table across both, which is what hydration buys in
// production.
describe("CodegraphEnrichmentProvider — incremental run, template file outside the batch (znxg8)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    // The taxdome shape: a class-method entry that self-instantiates and
    // delegates to the same-named instance template, which self-calls `perform`.
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      [
        "class KindOfService",
        "  def self.call",
        "    instance = new",
        "    instance.call",
        "  end",
        "  def call",
        "    perform",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/kind_of_service.rb");
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    paths.push("src/create.rb");
    writeFileSync(join(root, "src", "c.rb"), ["class C", "  def go", "    Create.call", "  end", "end", ""].join("\n"));
    paths.push("src/c.rb");
    return paths;
  };

  const methodEdges = async (): Promise<MethodEdge[]> =>
    client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-incremental-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-incremental-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps the entry narrowed to `Create#perform` when only the CALLER is re-walked", async () => {
    const paths = writeFixture();
    // Run 1 — full corpus. The registry is complete and the entry narrows.
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    expect(await methodEdges()).toContainEqual({
      source_symbol_id: "C#go",
      target_symbol_id: "Create#perform",
      call_expression: "Create.call",
    });

    // Run 2 — the caller alone changed, which is what an incremental reindex
    // walks. Neither the template's file nor the concrete service's is in it.
    writeFileSync(
      join(root, "src", "c.rb"),
      ["class C", "  def go", "    # touched", "    Create.call", "  end", "end", ""].join("\n"),
    );
    await provider.streamFileBatch(root, ["src/c.rb"]);
    await provider.finalizeSignals(root);

    const edges = await methodEdges();
    // The edge must SURVIVE the incremental re-walk unchanged.
    expect(edges).toContainEqual({
      source_symbol_id: "C#go",
      target_symbol_id: "Create#perform",
      call_expression: "Create.call",
    });
    // …and must never degrade onto the shared template node — that is the
    // 2324-fanIn hub the field report found 200/200 entry calls piled onto.
    expect(edges.filter((e) => e.source_symbol_id === "C#go" && e.target_symbol_id.startsWith("KindOfService"))).toEqual(
      [],
    );
  });
});

// bd tea-rags-mcp-znxg8 — the TOP-LEVEL-QUALIFIED entry call, `::Const.call`.
//
// The field report proposed this as a second, independent defect: `CONSTANT_RE`
// (ruby-self-dispatch-entry.ts) and `looksLikeConstant` (ruby-constant.ts) both
// anchor on `^[A-Z]`, so a receiver written `::TaxPreparation::…::ConfigureAndSend`
// would fail the shape test and the entry strategy would never look at it — 316
// such sites in taxdome against 3714 plain ones.
//
// The premise does not survive contact with the walker. Ruby's `::Foo::Bar` is a
// `scope_resolution` node whose leading `::` is an EMPTY first segment, and the
// walker rebuilds the receiver from the named segments, so what reaches the
// resolver is already `Foo::Bar` — the regexes never see a leading `::` on this
// shape and relaxing them would resolve nothing new. This test pins that end to
// end rather than by reading the walker: same fixture as the v2 delegation case,
// caller written top-level-qualified, and the edge must be identical.
//
// (The prefix DOES survive on a chained receiver — `::Foo::Bar.new.call` reaches
// the resolver as `::Foo::Bar.new` — but that is not a constant receiver and no
// `^[A-Z]` anchor would match `Foo::Bar.new` either. Whatever the 316 taxdome
// sites are losing, it is not these two regexes.)
describe("CodegraphEnrichmentProvider — top-level-qualified entry `::Const.call` (znxg8)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      [
        "class KindOfService",
        "  def self.call",
        "    instance = new",
        "    instance.call",
        "  end",
        "  def call",
        "    perform",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/kind_of_service.rb");
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    paths.push("src/create.rb");
    // The ONLY difference from the v2 fixture: the entry is written with the
    // top-level scope qualifier.
    writeFileSync(
      join(root, "src", "c.rb"),
      ["class C", "  def go", "    ::Create.call", "  end", "end", ""].join("\n"),
    );
    paths.push("src/c.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-toplevel-qualified-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-toplevel-qualified-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("resolves `::Create.call` to the concrete hook exactly as `Create.call` does", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

    expect(edges).toContainEqual({
      source_symbol_id: "C#go",
      target_symbol_id: "Create#perform",
      call_expression: "::Create.call",
    });
    // And it does not pile onto the shared template either.
    expect(edges.filter((e) => e.source_symbol_id === "C#go" && e.target_symbol_id.startsWith("KindOfService"))).toEqual(
      [],
    );
  });
});

// bd tea-rags-mcp-znxg8 — the UNNARROWED-ENTRY INVARIANT on `cg_run_stats`.
//
// Every other counter on that table describes a miss, which is exactly why none
// of them saw this defect: the degraded edges all RESOLVED. `inProjectEdgeRecall`
// read 1.0 while 200 of 200 sampled caller edges of one hub node were concrete
// entry calls that should have narrowed. This counter is the one that can move.
//
// The registry it checks matters as much as the check. The report's degraded
// edges pointed at `KindOfService.call` — the CLASS method, a
// `selfInstantiatingClassMethods` member. The template KEY for that idiom is the
// INSTANCE form `KindOfService#call`, so an invariant written against
// `selfDispatchTemplates` alone would have read zero on the very edges that
// prompted it. Both registries count, and this fixture pins the class-method
// half by resolving a `.call` the entry strategy cannot narrow.
describe("CodegraphEnrichmentProvider — unnarrowed-entry invariant on cg_run_stats (znxg8)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-unnarrowed-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-unnarrowed-fixture-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it("counts zero when every entry narrows to its concrete hook", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      [
        "class KindOfService",
        "  def self.call",
        "    instance = new",
        "    instance.call",
        "  end",
        "  def call",
        "    perform",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    writeFileSync(join(root, "src", "c.rb"), ["class C", "  def go", "    Create.call", "  end", "end", ""].join("\n"));

    await provider.streamFileBatch(root, ["src/kind_of_service.rb", "src/create.rb", "src/c.rb"]);
    await provider.finalizeSignals(root);

    const rows = await client.getRunStats();
    const total = rows.reduce((n, r) => n + (r.unnarrowedTemplate ?? 0), 0);
    expect(total).toBe(0);
  });

  it("counts the call when a subtype does NOT define the hook, so the entry stops at the shared class method", async () => {
    mkdirSync(join(root, "src"), { recursive: true });
    // Same shared entry, but TWO subtypes: one defines the hook (so the template
    // is discovered at all), the other does not — its `.call` therefore cannot
    // narrow and falls through to the inherited `KindOfService.call`.
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      [
        "class KindOfService",
        "  def self.call",
        "    instance = new",
        "    instance.call",
        "  end",
        "  def call",
        "    perform",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "hollow.rb"),
      ["class Hollow < KindOfService", "  def label", '    "hollow"', "  end", "end", ""].join("\n"),
    );
    writeFileSync(
      join(root, "src", "c.rb"),
      ["class C", "  def go", "    Hollow.call", "  end", "end", ""].join("\n"),
    );

    await provider.streamFileBatch(root, ["src/kind_of_service.rb", "src/create.rb", "src/hollow.rb", "src/c.rb"]);
    await provider.finalizeSignals(root);

    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );
    const degraded = edges.filter((e) => e.source_symbol_id === "C#go" && e.target_symbol_id === "KindOfService.call");
    // Precondition: the fixture really does produce the degraded shape. If the
    // resolver ever learns to decline this edge, the counter below goes to zero
    // for the RIGHT reason and this guard is what says so.
    expect(degraded).toHaveLength(1);

    const rows = await client.getRunStats();
    const total = rows.reduce((n, r) => n + (r.unnarrowedTemplate ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(1);
  });
});
