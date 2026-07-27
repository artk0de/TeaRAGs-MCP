/**
 * Incremental-hydration parity for the abstract-stub mark (bd tea-rags-mcp-eikry).
 *
 * The walker marks abstract stubs (bd bcdfe) and the self-dispatch probe treats a
 * stub as NOT a concrete definition of its member — that is what makes the
 * REDIRECT terminal fire. On an INCREMENTAL run the provider only walks changed
 * files; every unchanged file's defs come back through
 * `listAllSymbols` → `symbolTable.hydrate` (the pool `initHook` seam). If the
 * flag does not survive that round trip, a hydrated stub reads as concrete,
 * REDIRECT-template discovery degrades to pre-flag behaviour, and in a
 * mixed-hydration run a stub-only override can pass the choke-point guard.
 *
 * End-to-end through the REAL provider: Ruby source → walker → persisted
 * cg_symbols → a FRESH symbol table hydrated from disk → probe verdict.
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
import { buildSelfDispatchProbe } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/self-dispatch-discovery.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../../src/core/infra/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolvePath(__dirname, "../../../../../../src/core/infra/migration/database/migrations");

describe("CodegraphEnrichmentProvider — abstract-stub survives symbol-table hydration", () => {
  let tmp: string;
  let root: string;
  let client: DuckDbGraphClient;
  let provider: CodegraphEnrichmentProvider;

  const writeFixture = (): string[] => {
    mkdirSync(join(root, "src"), { recursive: true });
    // `KindOfService#perform` DECLARES the hook as a stub; only the concrete
    // subtype implements it. This is the shape the REDIRECT terminal exists for.
    writeFileSync(
      join(root, "src", "kind_of_service.rb"),
      [
        "class KindOfService",
        "  def call",
        "    perform",
        "  end",
        "",
        "  def perform",
        "    raise NotImplementedError",
        "  end",
        "end",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "src", "create.rb"),
      ["class Create < KindOfService", "  def perform", "    :done", "  end", "end", ""].join("\n"),
    );
    return ["src/kind_of_service.rb", "src/create.rb"];
  };

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-stub-hydrate-db-"));
    root = mkdtempSync(join(tmpdir(), "cg-stub-hydrate-fixture-"));
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

  it("a table hydrated from cg_symbols gives the same probe verdicts as the walked run", async () => {
    await provider.streamFileBatch(root, writeFixture());
    await provider.finalizeSignals(root);

    // Cold start of the NEXT (incremental) run: nothing is re-walked, the table
    // is rebuilt purely from persisted rows — exactly what the pool initHook does.
    const hydratedTable = new InMemoryGlobalSymbolTable();
    hydratedTable.hydrate(await client.listAllSymbols());
    const probe = buildSelfDispatchProbe(hydratedTable, undefined);

    // The base DECLARES `perform` but does not implement it: still not a
    // concrete definer after hydration.
    expect(probe.definesConcretely("KindOfService", "perform")).toBe(false);
    // The concrete override is untouched by the flag.
    expect(probe.definesConcretely("Create", "perform")).toBe(true);
    // Sanity: the stub def really is present in the hydrated table (a probe that
    // answers `false` because the row is MISSING would prove nothing).
    expect(
      hydratedTable
        .lookupByShortName("perform")
        .map((d) => `${d.symbolId}:${String(d.isAbstractStub ?? false)}`)
        .sort(),
    ).toEqual(["Create#perform:false", "KindOfService#perform:true"]);
  });
});
