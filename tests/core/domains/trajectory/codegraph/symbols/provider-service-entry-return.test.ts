/**
 * bd tea-rags-mcp-j9xpf — service-entry RETURN threading, e2e.
 * Spec: docs/superpowers/specs/2026-07-10-service-result-return-types-design.md.
 *
 * End-to-end through the REAL provider two-pass (walker → extraction → pass-1
 * accumulation → pass-1→pass-2 barrier discovery + return threading → ctx thread
 * → resolve chain). Faithful reproduction of the taxdome shape that G2's
 * body-last-expression source deliberately SILENCED:
 *
 *   result = Billing::Create.call(x)   # entry on a CONCRETE constant
 *   result.successful?                 # → KindOfService::Result#successful?
 *
 * The type IS statically known, one hop deeper than any single layer can see:
 * the shared template `KindOfService#call` ends in `@result`, itself assigned
 * once from a type-guard coercion ternary. The walker types the TEMPLATE; the
 * barrier re-keys that fact onto every CONCRETE entry the self-dispatch
 * discovery enumerates; the qualified local-call binding carries the entry
 * constant to the resolver. This test guards the FQ alignment across all four
 * seams — the unit tests inject hand-built maps and cannot catch a drift there.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — service-entry return threading (j9xpf)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  /** The shared base, verbatim in shape with taxdome's `lib/kind_of_service.rb`. */
  const KIND_OF_SERVICE = [
    "class KindOfService",
    "  def self.call",
    "    instance = new",
    "    instance.call",
    "  end",
    "  def call",
    "    raw = perform",
    "    @result = raw.is_a?(ServiceResult) ? raw : ServiceResult.new(raw)",
    "    @result",
    "  end",
    "end",
    "",
  ].join("\n");

  const SERVICE_RESULT = [
    "class ServiceResult",
    "  def initialize(payload)",
    "    @payload = payload",
    "  end",
    "  def successful?",
    "    @payload.present?",
    "  end",
    "  def errors",
    "    @payload",
    "  end",
    "end",
    "",
  ].join("\n");

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    writeFileSync(join(root, "src", "kind_of_service.rb"), KIND_OF_SERVICE);
    paths.push("src/kind_of_service.rb");
    writeFileSync(join(root, "src", "service_result.rb"), SERVICE_RESULT);
    paths.push("src/service_result.rb");
    // Two concrete entries wired to the shared base. Neither declares a return
    // type of its own — the fact must reach them from the template.
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    paths.push("src/create.rb");
    writeFileSync(
      join(root, "src", "refresh.rb"),
      ["class Refresh < KindOfService", "  def perform", "    :again", "  end", "end", ""].join("\n"),
    );
    paths.push("src/refresh.rb");
    // Caller: the dominant taxdome shape — assign the entry's result to a LOCAL,
    // then call members on it.
    writeFileSync(
      join(root, "src", "things_controller.rb"),
      [
        "class ThingsController",
        "  def go",
        "    result = Create.call(1)",
        "    result.successful?",
        "  end",
        "  def refresh",
        "    outcome = Refresh.call(2)",
        "    outcome.errors",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/things_controller.rb");
    // ATTRIBUTION GUARD. `Cache#call` also returns a typed tail, so the FLAT
    // `functionReturnTypes["call"]` channel (keyed by BARE method name,
    // last-write-wins run-global) ends up holding `CacheEntry` — walked last, it
    // wins that map. Every assertion below must therefore be answered by the
    // SCOPE-KEYED channel; a flat-channel win is visible as a `CacheEntry#…`
    // target. This is the precision argument for the whole mechanism: `call` is
    // the most collided method name in a Rails codebase.
    writeFileSync(
      join(root, "src", "cache_entry.rb"),
      ["class CacheEntry", "  def successful?", "    true", "  end", "end", ""].join("\n"),
    );
    paths.push("src/cache_entry.rb");
    // A concrete entry that DECLARES its own return type — the derived fact must
    // yield to it (declared wins), so `Special.call` types as `SpecialResult`.
    writeFileSync(
      join(root, "src", "special_result.rb"),
      ["class SpecialResult", "  def successful?", "    true", "  end", "end", ""].join("\n"),
    );
    paths.push("src/special_result.rb");
    writeFileSync(
      join(root, "src", "special.rb"),
      [
        "class Special < KindOfService",
        "  # @return [SpecialResult]",
        "  def call",
        "    SpecialResult.new(perform)",
        "  end",
        "  def perform",
        "    :special",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/special.rb");
    writeFileSync(
      join(root, "src", "declared_controller.rb"),
      [
        "class DeclaredController",
        "  def go",
        "    special = Special.call(3)",
        "    special.successful?",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    paths.push("src/declared_controller.rb");
    // LAST so it wins the flat, bare-name-keyed `functionReturnTypes["call"]`.
    writeFileSync(
      join(root, "src", "cache.rb"),
      ["class Cache", "  def call", "    CacheEntry.new(1)", "  end", "end", ""].join("\n"),
    );
    paths.push("src/cache.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-entry-return-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-entry-return-fixture-"));
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

  const runFixture = async (): Promise<MethodEdge[]> => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);
    return client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );
  };

  it("`result = Create.call(x); result.successful?` reaches the Result class's method", async () => {
    const edges = await runFixture();
    expect(edges).toContainEqual({
      source_symbol_id: "ThingsController#go",
      target_symbol_id: "ServiceResult#successful?",
      call_expression: "result.successful?",
    });
  });

  it("threads every concrete entry, not just the one that happens to be walked first", async () => {
    const edges = await runFixture();
    expect(edges).toContainEqual({
      source_symbol_id: "ThingsController#refresh",
      target_symbol_id: "ServiceResult#errors",
      call_expression: "outcome.errors",
    });
  });

  it("does NOT fabricate a second target for the result receiver (single, precise edge)", async () => {
    const edges = await runFixture();
    const fromResultVar = edges.filter((e) => e.call_expression === "result.successful?");
    expect(fromResultVar).toHaveLength(1);
  });

  it("the collided FLAT `call` return never wins — attribution is the scope-keyed channel", async () => {
    const edges = await runFixture();
    // `Cache#call` returns `CacheEntry`, which also answers `successful?`, and it
    // owns the flat bare-name map. No entry may resolve through it.
    expect(edges.filter((e) => e.target_symbol_id === "CacheEntry#successful?")).toHaveLength(0);
  });

  it("a DECLARED return type on the entry's own `#call` is NOT overridden by the derived fact", async () => {
    const edges = await runFixture();
    expect(edges).toContainEqual({
      source_symbol_id: "DeclaredController#go",
      target_symbol_id: "SpecialResult#successful?",
      call_expression: "special.successful?",
    });
  });
});
