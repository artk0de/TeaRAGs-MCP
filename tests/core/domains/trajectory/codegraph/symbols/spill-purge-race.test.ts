/**
 * bd tea-rags-mcp-v6gxr — a pool constructed MID-RUN must not delete the
 * output spill an in-flight sink is still appending to.
 *
 * The live failure was `Codegraph resolve failed after 0 files … ENOENT …
 * .spill/code_035da920_v10-<runId>.ndjson`: pass-1 wrote the spill, something
 * constructed a second `GraphDbClientPool` over the same `rootDir`, its
 * constructor `rmSync`ed the whole `.spill` directory, and `finish()` then
 * opened a file that no longer existed.
 *
 * Two constructors reach that state in a normal `--force-enrichments codegraph`
 * run, and both are reproduced here as "a second pool over the same rootDir":
 *
 *   - the pass-1 extraction fan-out (`executor/extraction-fanout.ts`) dispatches
 *     `extractFileBatch` with NO routing key, so an UNPINNED enrichment worker
 *     builds its own codegraph provider — and therefore its own pool — while the
 *     affinity worker's sink is mid-spill;
 *   - the codegraph daemon is spawned lazily on the first write, i.e. also
 *     mid-run, and `runDaemon` builds a pool over the same `rootDir`.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTestCodegraphDeps } from "../__helpers__/language-factory.js";
import { GraphDbClientPool } from "../../../../../../src/core/adapters/duckdb/pool.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { createDatabaseMigrationApplier } from "../../../../../../src/core/domains/maintenance/migration/database/index.js";
import { CodegraphEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

describe("codegraph spill — a mid-run pool construction must not purge a live spill", () => {
  let tmp: string;
  const pools: GraphDbClientPool[] = [];

  function newPool(): GraphDbClientPool {
    const pool = new GraphDbClientPool({
      rootDir: tmp,
      symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
      applyMigrations: createDatabaseMigrationApplier(),
    });
    pools.push(pool);
    return pool;
  }

  function newProvider(pool: GraphDbClientPool): CodegraphEnrichmentProvider {
    return new CodegraphEnrichmentProvider({
      pool,
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  }

  const extraction = {
    relPath: "src/index.ts",
    language: "typescript" as const,
    imports: [],
    chunks: [{ symbolId: "main", scope: [], calls: [] }],
    fileScope: [],
  };

  /**
   * `createWriteStream` opens its fd asynchronously, so the spill is on disk a
   * few ticks after `write()` resolves. Every test here is about what a pool
   * built against an EXISTING file does, so each one waits for it first.
   */
  async function spillsOnDisk(count: number): Promise<string[]> {
    const spillDir = join(tmp, "codegraph", ".spill");
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = readdirSync(spillDir)
        .filter((n) => n.endsWith(".ndjson"))
        .sort();
      if (found.length >= count) return found.map((n) => join(spillDir, n));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`fewer than ${count} spill files materialised`);
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cg-spill-race-"));
  });

  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.closeAll();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("survives a second pool built over the same rootDir while pass-1 is writing", async () => {
    const sink = newProvider(newPool()).asExtractionSink("alpha");
    await sink.write(extraction);
    const [spill] = await spillsOnDisk(1);

    // The fan-out worker / lazily-spawned daemon builds its own pool here.
    newPool();

    expect(existsSync(spill)).toBe(true);
    await expect(sink.finish()).resolves.toBeUndefined();
  });

  it("keeps a live spill safe against every worker of a 4-thread pool", async () => {
    const sink = newProvider(newPool()).asExtractionSink("alpha");
    await sink.write(extraction);
    const [spill] = await spillsOnDisk(1);

    // INGEST_TUNE_ENRICHMENT_POOL_SIZE=4 — three unpinned workers may each
    // rebuild the provider in-thread for the extraction half.
    newPool();
    newPool();
    newPool();

    expect(existsSync(spill)).toBe(true);
    await expect(sink.finish()).resolves.toBeUndefined();
  });

  it("keeps a concurrent CLI run's spill on a different collection", async () => {
    // Two overlapping `index-codebase` processes share one data dir. Run A is
    // mid-pass-1 on `alpha`; run B's composition root builds its pool at start.
    const runA = newProvider(newPool()).asExtractionSink("alpha");
    await runA.write(extraction);
    const [spillA] = await spillsOnDisk(1);

    const runB = newProvider(newPool()).asExtractionSink("beta");
    await runB.write({ ...extraction, relPath: "lib/other.ts" });
    expect(await spillsOnDisk(2)).toHaveLength(2);
    expect(existsSync(spillA)).toBe(true);

    await expect(runA.finish()).resolves.toBeUndefined();
    await expect(runB.finish()).resolves.toBeUndefined();
  });
});
