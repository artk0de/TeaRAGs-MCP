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
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

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
      writeFileSync(
        join(root, "src", `service_${i}.rb`),
        `class Service${i} < KindOfService\n  def perform\n  end\n${fillers}end\n`,
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
    // Concrete subclass defines the `#perform` hook (via `<` so classAncestors carries it).
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "  end", "end", ""].join("\n"),
    );
    paths.push("src/create.rb");
    // Caller: a concrete entry through the shared self-instantiating class method.
    writeFileSync(
      join(root, "src", "c.rb"),
      ["class C", "  def go", "    Create.call", "  end", "end", ""].join("\n"),
    );
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
