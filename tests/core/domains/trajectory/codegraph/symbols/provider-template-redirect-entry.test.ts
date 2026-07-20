/**
 * bd tea-rags-mcp — DEFECT 2 G4 (instance-rooted self-dispatch template redirect), e2e.
 * Spec: docs/superpowers/specs/2026-07-10-instance-template-redirect-design.md.
 *
 * End-to-end through the REAL provider two-pass (walker → extraction → pass-1
 * self-dispatch accumulation → barrier discovery → ctx thread → strategy chain →
 * central post-resolution redirect). The taxdome instance-form recall hole:
 *
 *   service = Create.new   # localBindings types `service` as Create
 *   service.call           # resolves to the INHERITED template KindOfService#call
 *
 * `KindOfService#call` self-calls the abstract `perform` hook that only the
 * concrete subtype `Create` defines. Without the redirect the edge lands on the
 * shared template node (`C#go → KindOfService#call`) and `get_callers(Create#perform)`
 * is `[]`. The redirect narrows the entry-anchored edge to `C#go → Create#perform`
 * — the concrete hook — using the receiver's local-binding type. This exercises
 * the typed-INSTANCE receiver path v1/v2 (constant entries) do NOT anchor, and
 * guards FQ alignment across walker/accumulator/barrier/resolver that unit tests
 * (hand-built maps) cannot catch.
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
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

interface MethodEdge {
  source_symbol_id: string;
  target_symbol_id: string;
  call_expression: string;
}

describe("CodegraphEnrichmentProvider — instance-rooted template redirect (DEFECT 2 G4)", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    const paths: string[] = [];
    // Shared INSTANCE self-dispatch template: `#call` self-calls the abstract
    // `perform` hook. `KindOfService` never defines `perform`.
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      ["class KindOfService", "  def call", "    perform", "  end", "end", ""].join("\n"),
    );
    paths.push("src/kind_of_service.rb");
    // Concrete subclass defines the `#perform` hook (via `<` so classAncestors carries it).
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "  end", "end", ""].join("\n"),
    );
    paths.push("src/create.rb");
    // Caller: a typed-instance entry — `service = Create.new; service.call` — the
    // shape v1/v2 do NOT anchor (lowercase receiver, not a constant entry).
    writeFileSync(
      join(root, "src", "c.rb"),
      ["class C", "  def go", "    service = Create.new", "    service.call", "  end", "end", ""].join("\n"),
    );
    paths.push("src/c.rb");
    return paths;
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-template-redirect-prov-"));
    root = mkdtempSync(join(tmpdir(), "cg-template-redirect-fixture-"));
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

  it("redirects the typed-instance `service.call` from the template node to the concrete `Create#perform`", async () => {
    const paths = writeFixture();
    await provider.streamFileBatch(root, paths);
    await provider.finalizeSignals(root);

    const edges = await client.queryAll<MethodEdge>(
      "SELECT source_symbol_id, target_symbol_id, call_expression FROM cg_symbols_edges_method",
    );

    // ── Entry-anchored redirect: `C#go` reaches the concrete hook, the SOLE edge.
    const goToConcrete = edges.filter(
      (e) => e.source_symbol_id === "C#go" && e.target_symbol_id === "Create#perform",
    );
    expect(goToConcrete).toHaveLength(1);
    expect(goToConcrete[0].call_expression).toBe("service.call");

    // ── Bypass: the redirected edge lands on the concrete hook, NOT the shared
    // template node — `C#go` does not also record an edge to `KindOfService#call`.
    const goToTemplate = edges.filter(
      (e) => e.source_symbol_id === "C#go" && e.target_symbol_id === "KindOfService#call",
    );
    expect(goToTemplate).toHaveLength(0);
  });
});
