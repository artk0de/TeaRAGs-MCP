/**
 * Per-language codegraph affinity, end to end (bd tea-rags-mcp-sgo8v): a
 * `--force-enrichments codegraph` recompute over a mixed TypeScript + Ruby +
 * JavaScript corpus leaves the SAME graph and the SAME Qdrant payload whether
 * the collection is served by one worker or by one worker per language.
 *
 * Nothing on the path is a double except Qdrant: the real `EnrichmentCoordinator`
 * and its `CompletionRunner`, the real `WorkerPoolEnrichmentExecutor` running the
 * COMPILED enrichment worker (run `npm run build` first), the codegraph provider
 * rebuilt in each worker from the descriptor `wireCodegraph` ships, and a real
 * codegraph daemon (in-process, its own socket) that every worker's writes
 * multiplex onto — the production write path, where the partitions' pass-2
 * transactions really do interleave on one connection. Everything lives under
 * one `mkdtemp` directory; the machine's daemon, Qdrant and registry are never
 * touched.
 *
 * The two runs differ ONLY in `CODEGRAPH_LANGUAGE_AFFINITY`, the kill-switch.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../../__helpers__/test-helpers.js";
import { DuckDbGraphClient } from "../../../../../../../src/core/adapters/duckdb/client.js";
import { runDaemon } from "../../../../../../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths } from "../../../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import { GraphDbClientPool } from "../../../../../../../src/core/adapters/duckdb/pool.js";
import { INDEXING_METADATA_ID } from "../../../../../../../src/core/contracts/constants.js";
import type { WorkerEnrichmentDescriptor } from "../../../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { WorkerPoolEnrichmentExecutor } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";
import { pipelineLog } from "../../../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import { LanguageFactory } from "../../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../../src/core/domains/language/kernel/symbol-id.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../../../src/core/domains/maintenance/migration/database/index.js";
import type { CodegraphWorkerConfig } from "../../../../../../../src/core/domains/trajectory/codegraph/factory.js";
import { CODEGRAPH_LANGUAGE_BY_EXTENSION } from "../../../../../../../src/core/domains/trajectory/codegraph/index.js";
import { CodegraphEnrichmentProvider } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  cycleMemberSets,
  dumpCodegraphTables,
  ORDER_SENSITIVE_ANALYTICS_TABLES,
  PAGE_RANK_EPSILON,
  pageRanksBySymbol,
} from "../../../../trajectory/codegraph/__helpers__/graph-db-dump.js";
import {
  MIXED_LANGUAGE_CORPUS,
  writeMixedLanguageCorpus,
} from "../../../../trajectory/codegraph/__helpers__/mixed-language-corpus.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../..");
const BUILD = join(REPO_ROOT, "build/core");
const WORKER_PATH = join(BUILD, "domains/ingest/pipeline/enrichment/infra/worker.js");
const CODEGRAPH_FACTORY_MODULE = join(BUILD, "domains/trajectory/codegraph/factory.js");
const LANGUAGE_MODULE = join(BUILD, "domains/language/index.js");
const MIGRATIONS_MODULE = join(BUILD, "domains/maintenance/migration/database/index.js");

const COLLECTION = "code_sgo8v_parity";

interface RecomputeOutcome {
  tables: Record<string, string[]>;
  /** `pointId → codegraph payload`, run stamps removed. */
  payloads: Map<string, unknown>;
  partitionLabels: string[];
}

function pointIdOf(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function findDuckDbFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...findDuckDbFiles(path));
    else if (entry.endsWith(".duckdb")) out.push(path);
  }
  return out;
}

/** The codegraph subtree of a payload, without the per-run `enrichedAt` stamps. */
function withoutRunStamps(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutRunStamps);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "enrichedAt")
        .map(([key, inner]) => [key, withoutRunStamps(inner)]),
    );
  }
  return value;
}

async function recompute(mode: "collection" | "language"): Promise<RecomputeOutcome> {
  if (mode === "collection") process.env.CODEGRAPH_LANGUAGE_AFFINITY = "0";
  else delete process.env.CODEGRAPH_LANGUAGE_AFFINITY;

  // Short prefix: the keyed daemon socket (bd tea-rags-mcp-42hno) must stay
  // inside the macOS 104-byte unix-socket path limit.
  const root = mkdtempSync(join(tmpdir(), `la-${mode}-`));
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const corpus = writeMixedLanguageCorpus(repoRoot);
  const dataRoot = join(root, "data");
  const daemonPaths = getDaemonPaths(join(root, "d"));
  mkdirSync(daemonPaths.storageDir, { recursive: true });
  const daemon = await runDaemon({
    rootDir: dataRoot,
    paths: daemonPaths,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    buildFingerprint: "sgo8v-lifecycle-daemon",
    exit: () => undefined,
  });

  const workerConfig: CodegraphWorkerConfig = {
    languageModulePath: LANGUAGE_MODULE,
    migrationsModulePath: pathToFileURL(MIGRATIONS_MODULE).href,
    daemonSocketPath: daemonPaths.socketPath,
    rootDir: dataRoot,
  };
  // The descriptor `wireCodegraph` ships.
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: CODEGRAPH_FACTORY_MODULE,
    providerFactoryExport: "createCodegraphEnrichmentProvider",
    dispatch: "collection-affinity",
    extractionFanout: true,
    languageAffinity: { partitionByExtension: CODEGRAPH_LANGUAGE_BY_EXTENSION },
    serializableConfig: workerConfig,
  };
  const mainPool = new GraphDbClientPool({
    rootDir: dataRoot,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: daemonPaths.socketPath,
  });
  const provider = new CodegraphEnrichmentProvider(
    { pool: mainPool, languageFactory: new LanguageFactory(), composer: new DefaultSymbolIdComposer(), collectSymbols },
    descriptor,
  );

  const qdrant = new MockQdrantManager();
  await qdrant.createCollection(COLLECTION, 384);
  await qdrant.addPoints(COLLECTION, [
    { id: INDEXING_METADATA_ID, vector: [], payload: { indexingComplete: true } },
    ...corpus.map((relPath, index) => ({
      id: pointIdOf(index),
      vector: [],
      payload: {
        relativePath: relPath,
        startLine: 1,
        endLine: MIXED_LANGUAGE_CORPUS[relPath].split("\n").length,
        language: CODEGRAPH_LANGUAGE_BY_EXTENSION[relPath.slice(relPath.lastIndexOf("."))] ?? "markdown",
      },
    })),
  ]);

  // One file per thread: the fixture's languages each earn their worker.
  const executor = new WorkerPoolEnrichmentExecutor(4, WORKER_PATH, 1);
  const coordinator = new EnrichmentCoordinator(qdrant as never, [provider], undefined, executor);
  const phase = vi.spyOn(pipelineLog, "enrichmentPhase");
  try {
    await coordinator.recomputeEnrichments(COLLECTION as never, repoRoot, ["codegraph"]);
    await coordinator.whenCompletionsSettled(COLLECTION);

    const affinityLine = phase.mock.calls.find(([name]) => name === "CODEGRAPH_LANGUAGE_AFFINITY");
    const partitionLabels = (
      (affinityLine?.[1] as { partitions?: { label: string }[] } | undefined)?.partitions ?? []
    ).map((p) => p.label);
    const payloads = new Map<string, unknown>();
    for (const [index] of corpus.entries()) {
      const point = await qdrant.getPoint(COLLECTION, pointIdOf(index));
      payloads.set(corpus[index], withoutRunStamps((point?.payload as Record<string, unknown> | undefined)?.codegraph));
    }

    await executor.shutdown();
    await mainPool.closeAll();
    await daemon.shutdown();

    const [dbFile] = findDuckDbFiles(dataRoot);
    const client = new DuckDbGraphClient({ path: dbFile });
    await client.init();
    try {
      return { tables: await dumpCodegraphTables(client), payloads, partitionLabels };
    } finally {
      await client.close();
    }
  } finally {
    phase.mockRestore();
    await executor.shutdown().catch(() => undefined);
    await daemon.shutdown().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}

function chunkPageRanks(payloads: Map<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [relPath, payload] of payloads) {
    const pageRank = (payload as { symbols?: { chunk?: { pageRank?: number } } } | undefined)?.symbols?.chunk?.pageRank;
    if (typeof pageRank === "number") out.set(relPath, pageRank);
  }
  return out;
}

function withoutChunkPageRank(payloads: Map<string, unknown>): Map<string, unknown> {
  return new Map(
    [...payloads].map(([relPath, payload]) => {
      const symbols = (payload as { symbols?: { chunk?: Record<string, unknown> } } | undefined)?.symbols;
      if (!symbols?.chunk) return [relPath, payload];
      const { pageRank: _pageRank, ...chunk } = symbols.chunk;
      return [relPath, { ...(payload as object), symbols: { ...symbols, chunk } }];
    }),
  );
}

describe("per-language affinity — end-to-end recompute parity", () => {
  afterEach(() => {
    delete process.env.CODEGRAPH_LANGUAGE_AFFINITY;
  });

  it("one worker per language leaves the graph and the payload one worker per collection leaves", async () => {
    const single = await recompute("collection");
    const split = await recompute("language");

    // The two runs really took the two shapes.
    expect(single.partitionLabels).toEqual([]);
    expect(split.partitionLabels).toEqual(["typescript", "javascript+ruby"]);
    expect(single.tables.cg_symbols_edges_method.length).toBeGreaterThan(0);
    expect(single.tables.cg_symbols_cycles.length).toBeGreaterThan(0);

    for (const table of Object.keys(single.tables)) {
      if (ORDER_SENSITIVE_ANALYTICS_TABLES.includes(table)) continue;
      expect(split.tables[table], table).toEqual(single.tables[table]);
    }
    expect(cycleMemberSets(split.tables.cg_symbols_cycles)).toEqual(cycleMemberSets(single.tables.cg_symbols_cycles));
    const expectedRanks = pageRanksBySymbol(single.tables.cg_symbols_metrics);
    const actualRanks = pageRanksBySymbol(split.tables.cg_symbols_metrics);
    expect([...actualRanks.keys()].sort()).toEqual([...expectedRanks.keys()].sort());
    for (const [symbol, rank] of expectedRanks) {
      expect(Math.abs((actualRanks.get(symbol) ?? Number.NaN) - rank), symbol).toBeLessThanOrEqual(PAGE_RANK_EPSILON);
    }

    // Every file got its codegraph payload in both runs, and the same one.
    expect([...single.payloads.values()].every((payload) => payload !== undefined)).toBe(true);
    expect(withoutChunkPageRank(split.payloads)).toEqual(withoutChunkPageRank(single.payloads));
    const singleChunkRanks = chunkPageRanks(single.payloads);
    const splitChunkRanks = chunkPageRanks(split.payloads);
    expect([...splitChunkRanks.keys()].sort()).toEqual([...singleChunkRanks.keys()].sort());
    for (const [relPath, rank] of singleChunkRanks) {
      expect(Math.abs((splitChunkRanks.get(relPath) ?? Number.NaN) - rank), relPath).toBeLessThanOrEqual(
        PAGE_RANK_EPSILON,
      );
    }
  }, 120_000);
});
