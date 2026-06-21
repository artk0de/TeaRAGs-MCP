/**
 * yl9tv Task 5 — cross-pass channel bridge.
 *
 * The chunk pass tees each file's codegraph `FileExtraction` into the provider
 * via `acceptExtraction`; the provider writes it to the run spill. Once a run is
 * fed this way, `streamFileBatch` becomes a NO-OP for parsing (the main-thread
 * `extractOneFile` re-parse is skipped), and `finalizeSignals` resolves the
 * pre-spilled extractions exactly as before. This test feeds two extractions
 * through the bridge, asserts ZERO `extractOneFile` calls, and confirms both
 * files' symbols were persisted.
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

function extraction(relPath: string, klass: string, method: string): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [klass],
    chunks: [{ symbolId: `${klass}#${method}`, scope: [klass], calls: [], startLine: 1, endLine: 3 }],
  };
}

describe("codegraph cross-pass extraction bridge (yl9tv)", () => {
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
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("accepts pre-built extractions, no-ops streamFileBatch parsing, and resolves on finalize", async () => {
    const extractOneFileSpy = vi.spyOn(provider as unknown as { extractOneFile: () => unknown }, "extractOneFile");

    await provider.acceptExtraction(extraction("a.rb", "Alpha", "one"));
    await provider.acceptExtraction(extraction("b.rb", "Beta", "two"));

    // Both symbols were written to the in-memory table by the sink.
    expect(symbolTable.lookupByShortName("one").map((s) => s.symbolId)).toContain("Alpha#one");
    expect(symbolTable.lookupByShortName("two").map((s) => s.symbolId)).toContain("Beta#two");

    // streamFileBatch over the SAME paths must NOT re-parse — the run is
    // cross-pass-fed, so extractOneFile is never invoked.
    await provider.streamFileBatch(tmp, ["a.rb", "b.rb"], {});
    expect(extractOneFileSpy).not.toHaveBeenCalled();

    // finalizeSignals reads the spill back and resolves without error.
    const overlays = await provider.finalizeSignals(tmp, { paths: ["a.rb", "b.rb"] });
    expect(overlays).toBeInstanceOf(Map);
    // Still zero parses across the whole run.
    expect(extractOneFileSpy).not.toHaveBeenCalled();
  });

  it("falls back to extractOneFile in direct mode when no extraction was fed", async () => {
    // No acceptExtraction → run is NOT cross-pass-fed → streamFileBatch keeps its
    // extractOneFile path. The fixture file does not exist on disk, so the
    // extraction throws and is swallowed, but the spy proves the parse was
    // attempted (the direct-mode fallback is intact).
    const extractOneFileSpy = vi.spyOn(provider as unknown as { extractOneFile: () => unknown }, "extractOneFile");
    await provider.streamFileBatch(tmp, ["ghost.rb"], {});
    expect(extractOneFileSpy).toHaveBeenCalled();
  });
});
