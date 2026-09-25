/**
 * The walker's type-abstractness census reaches `cg_symbols_files` and comes
 * back on `readFileDependencyGraph` (bd tea-rags-mcp-r8hme.8, migration 032).
 *
 * Driven through the production cross-pass split — the main instance tees each
 * extraction into the NDJSON spill, a separate worker instance drains it and
 * writes pass-2 — so the census has to survive the spill, the finalizer's node
 * build and the row diff. A file whose extraction carried no census reads back
 * without one: "not measured" is never collapsed into "no types".
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { DuckDbGraphClient } from "../../../../../../src/core/adapters/duckdb/client.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../src/core/domains/maintenance/migration/database/migrations");

function mkExtraction(relPath: string, klass: string, census?: FileExtraction["typeAbstractness"]): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [klass],
    chunks: [{ symbolId: `${klass}#run`, scope: [klass], calls: [], startLine: 1, endLine: 3 }],
    ...(census ? { typeAbstractness: census } : {}),
  };
}

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("CodegraphEnrichmentProvider — type-abstractness census persistence", () => {
  it("persists each file's census and reads it back, leaving an unmeasured file without one", async () => {
    const extractions = [
      mkExtraction("base.rb", "Base", { abstractTypeCount: 1, concreteTypeCount: 2 }),
      mkExtraction("empty.rb", "Empty", { abstractTypeCount: 0, concreteTypeCount: 0 }),
      mkExtraction("legacy.rb", "Legacy"),
    ];
    const collectionName = `census_${randomUUID().replace(/-/g, "")}`;
    const tmp = mkdtempSync(join(tmpdir(), "cg-census-"));
    const graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await graphDb.init();
    await runMigrations(graphDb, MIG_DIR);
    cleanups.push(async () => {
      await graphDb.close();
      rmSync(tmp, { recursive: true, force: true });
    });
    const deps = {
      graphDb,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    };
    const mainProvider = new CodegraphEnrichmentProvider(deps);
    const workerProvider = new CodegraphEnrichmentProvider({ ...deps, symbolTable: new InMemoryGlobalSymbolTable() });

    mainProvider.beginExtractionRun(collectionName);
    for (const e of extractions) mainProvider.acceptExtraction(e, { collectionName });
    await mainProvider.endExtractionRun(collectionName);
    await workerProvider.finalizeSignals(tmp, {
      crossPass: true,
      paths: extractions.map((e) => e.relPath),
      collectionName,
    });

    const { files } = await graphDb.readFileDependencyGraph();
    const byPath = new Map(files.map((f) => [f.relPath, f]));
    expect(byPath.get("base.rb")?.typeAbstractness).toEqual({ abstractTypeCount: 1, concreteTypeCount: 2 });
    expect(byPath.get("empty.rb")?.typeAbstractness).toEqual({ abstractTypeCount: 0, concreteTypeCount: 0 });
    expect(byPath.get("legacy.rb") && "typeAbstractness" in byPath.get("legacy.rb")!).toBe(false);
  });
});
