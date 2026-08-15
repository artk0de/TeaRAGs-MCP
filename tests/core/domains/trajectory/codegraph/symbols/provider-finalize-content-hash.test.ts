/**
 * `finalizeSignals` stamps the run's content hashes onto the rows pass-2 writes
 * (bd tea-rags-mcp-o317j).
 *
 * `graph-finalizer` reads `runState.contentHashes` when it buffers each file's
 * `{ relPath, language, contentHash }` — so whichever call seeded that map
 * decides whether `cg_symbols_files.content_hash` lands populated or NULL.
 * Until now only `streamFileBatch` / `buildFileSignals` seeded it, and on a
 * CROSS-PASS run (first index, `--force`) `streamFileBatch` no-ops on a separate
 * WORKER instance whose run state the main instance never touches. Every row
 * that run wrote carried NULL, and the next run's repair check read NULL as
 * "unknown, re-extract" for the whole corpus.
 *
 * The finalize dispatch is the seam that covers every path, because pass-2 —
 * the only writer of `cg_symbols_files` — always runs inside it.
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

function mkExtraction(relPath: string, klass: string): FileExtraction {
  return {
    relPath,
    language: "ruby",
    imports: [],
    fileScope: [klass],
    chunks: [{ symbolId: `${klass}#run`, scope: [klass], calls: [], startLine: 1, endLine: 3 }],
  };
}

const EXTRACTIONS: readonly FileExtraction[] = [mkExtraction("alpha.rb", "Alpha"), mkExtraction("beta.rb", "Beta")];

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/**
 * The production cross-pass split: the MAIN instance tees every extraction into
 * the input spill, a SEPARATE WORKER instance drains it and resolves pass-2.
 * Returns what `cg_symbols_files` ended up holding.
 */
async function runCrossPass(contentHashes?: ReadonlyMap<string, string>): Promise<Map<string, string | null>> {
  const collectionName = `finalize_hash_${randomUUID().replace(/-/g, "")}`;
  const paths = EXTRACTIONS.map((e) => e.relPath);

  const tmp = mkdtempSync(join(tmpdir(), "cg-finalize-hash-"));
  const graphDb = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
  await graphDb.init();
  await runMigrations(graphDb, MIG_DIR);

  const deps = {
    graphDb,
    symbolTable: new InMemoryGlobalSymbolTable(),
    ...buildTestCodegraphDeps(),
    composer: new DefaultSymbolIdComposer(),
    collectSymbols,
  };
  const mainProvider = new CodegraphEnrichmentProvider(deps);
  const workerProvider = new CodegraphEnrichmentProvider({ ...deps, symbolTable: new InMemoryGlobalSymbolTable() });

  cleanups.push(async () => {
    await graphDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  mainProvider.beginExtractionRun(collectionName);
  for (const e of EXTRACTIONS) mainProvider.acceptExtraction(e, { collectionName });
  await mainProvider.endExtractionRun(collectionName);

  await workerProvider.finalizeSignals(tmp, { crossPass: true, paths, collectionName, contentHashes });

  const rows = await graphDb.listFileContentHashes();
  return new Map(rows.map((r) => [r.relPath, r.contentHash]));
}

describe("CodegraphEnrichmentProvider.finalizeSignals — content-hash stamp", () => {
  it("stamps the hashes the finalize options carried onto every row pass-2 writes", async () => {
    const hashes = new Map([
      ["alpha.rb", "a".repeat(64)],
      ["beta.rb", "b".repeat(64)],
    ]);

    expect(await runCrossPass(hashes)).toEqual(hashes);
  });

  it("writes NULL when the run supplied no hashes, so the next run re-extracts rather than trusting the row", async () => {
    expect(await runCrossPass()).toEqual(
      new Map([
        ["alpha.rb", null],
        ["beta.rb", null],
      ]),
    );
  });
});
