/**
 * yl9tv Task 5b — worker-owned input-spill cross-pass bridge.
 *
 * On the full-index path the chunk pass tees each file's codegraph
 * `FileExtraction` to the provider's `acceptExtraction`, which SYNC-APPENDS it
 * to a deterministic input spill on disk — no symbol upsert, no sink on the
 * (main-thread) instance. The off-thread worker's `finalizeSignals(crossPass)`
 * drains that exact file: pass-1 (symbol upsert + output-spill append) per line,
 * then pass-2 resolve. `streamFileBatch(crossPass)` is a parse NO-OP. This test
 * exercises the contract against a single provider instance (direct mode, cwd
 * input-spill fallback) and asserts ZERO `extractOneFile` calls across the
 * cross-pass run, plus the non-cross-pass fallback still re-parses.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { CodegraphEnrichmentProvider } from "../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { runMigrations } from "../../../../../src/core/infra/migration/database/runner.js";
import { buildTestCodegraphDeps } from "../../trajectory/codegraph/__helpers__/language-factory.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../src/core/infra/migration/database/migrations");

// Direct-mode (no pool) input spill for the undefined-collection case. Clean up
// ONLY this exact file between tests — the parent `.tea-rags-codegraph-spill`
// dir is shared with other direct-mode codegraph tests running in parallel
// (their `asExtractionSink` output spills live there too), so wiping the whole
// dir would race their in-flight writes.
const DIRECT_INPUT_SPILL = join(process.cwd(), ".tea-rags-codegraph-spill", "xpass-__direct__.ndjson");

function extraction(relPath: string, klass: string, method: string): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [klass],
    chunks: [{ symbolId: `${klass}#${method}`, scope: [klass], calls: [], startLine: 1, endLine: 3 }],
  };
}

describe("codegraph cross-pass input-spill bridge (yl9tv Task 5b)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let symbolTable: InMemoryGlobalSymbolTable;
  let provider: CodegraphEnrichmentProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-bridge-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    symbolTable = new InMemoryGlobalSymbolTable();
    provider = new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable,
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
    rmSync(DIRECT_INPUT_SPILL, { force: true });
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
    rmSync(DIRECT_INPUT_SPILL, { force: true });
  });

  it("appends to the input spill, no-ops streamFileBatch, and drains on cross-pass finalize", async () => {
    const extractOneFileSpy = vi.spyOn(provider as unknown as { extractOneFile: () => unknown }, "extractOneFile");

    provider.beginExtractionRun();
    provider.acceptExtraction(extraction("a.rb", "Alpha", "one"));
    provider.acceptExtraction(extraction("b.rb", "Beta", "two"));

    // acceptExtraction is a pure input-spill append: symbols are NOT yet in the
    // table (the worker drains + upserts them only at finalize).
    expect(symbolTable.lookupByShortName("one")).toHaveLength(0);

    // streamFileBatch with crossPass must NOT re-parse — finalize owns pass-1.
    await provider.streamFileBatch(tmp, ["a.rb", "b.rb"], { crossPass: true });
    expect(extractOneFileSpy).not.toHaveBeenCalled();

    // finalize drains the input spill: symbols land, edges resolve, still zero parses.
    const overlays = await provider.finalizeSignals(tmp, { crossPass: true, paths: ["a.rb", "b.rb"] });
    expect(overlays).toBeInstanceOf(Map);
    expect(symbolTable.lookupByShortName("one").map((s) => s.symbolId)).toContain("Alpha#one");
    expect(symbolTable.lookupByShortName("two").map((s) => s.symbolId)).toContain("Beta#two");
    expect(extractOneFileSpy).not.toHaveBeenCalled();
  });

  it("falls back to extractOneFile when the run is not cross-pass", async () => {
    // No crossPass flag → streamFileBatch keeps its extractOneFile path. The
    // fixture file does not exist on disk, so the extraction throws and is
    // swallowed, but the spy proves the parse was attempted.
    const extractOneFileSpy = vi.spyOn(provider as unknown as { extractOneFile: () => unknown }, "extractOneFile");
    await provider.streamFileBatch(tmp, ["ghost.rb"], {});
    expect(extractOneFileSpy).toHaveBeenCalled();
  });
});
