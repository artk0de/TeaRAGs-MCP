/**
 * Every producer of `codegraph.symbols.chunk.*` settles a stored chunk through
 * ONE computation over an explicit range source (bd tea-rags-mcp-39xca.2).
 *
 * Four paths write those keys onto the same points: the deferred chunk pass
 * (`ChunkPhase#runDeferredChunk`), the backfiller's chunk half, recovery's
 * in-place heal of files the walk cannot extract, and the payload heal. They
 * shared the owner rule but each fed it a different range source, and "no
 * ranges" degraded silently: the deferred pass stamped `enrichedAt` over empty
 * overlays (fxio5), the heal fell back to anchor owners on pre-024 rows (71n0p).
 *
 * The table runs every REACHABLE producer × source cell against one real graph
 * and one in-memory collection, and reads back the payload each produced.
 * Cells left out are unreachable by design:
 *  - recovery never computes an extractable file — it hands it to the reindex
 *    run's repair walk (fxio5) — so its walker.ts cells assert the handoff;
 *  - the payload heal reads PERSISTED ranges only, so "walked file without
 *    ranges" is not an input it can see, and it rewrites chunks whose owner
 *    moved rather than stamping — block and json chunks are never its to write.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { createCodegraphPayloadHealRunner } from "../../../../../src/core/api/internal/infra/codegraph-payload-heal-runner.js";
import type { ChunkExtraction, GraphDbClient } from "../../../../../src/core/contracts/types/codegraph.js";
import type { ChunkLookupEntry } from "../../../../../src/core/contracts/types/provider.js";
import { EnrichmentApplier } from "../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import type { BatchPayloadOp } from "../../../../../src/core/domains/ingest/pipeline/enrichment/batch-write.js";
import { ChunkPhase } from "../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { EnrichmentRecovery } from "../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";
import type { ChunkItem } from "../../../../../src/core/domains/ingest/pipeline/types.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { TSCallResolver } from "../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { CodegraphEnrichmentProvider } from "../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { MockQdrantManager } from "../../../domains/ingest/__helpers__/test-helpers.js";
import { buildTestCodegraphDeps } from "../../../domains/trajectory/codegraph/__helpers__/language-factory.js";

const COLL = "code_producers";
const ROOT = "/repo";
const ENRICHED_AT = "2026-09-15T00:00:00.000Z";
const PROVIDER_KEY = "codegraph.symbols";
const WALKER = "src/walker.ts";
const CONFIG = "config/settings.json";
const OUTER = "collectPythonInheritanceEdges";
const NESTED = "collectPythonInheritanceEdges.walkScope";

interface StoredChunk {
  id: "head" | "nested" | "block" | "json";
  relativePath: string;
  startLine: number;
  endLine: number;
  symbolId?: string;
}

/** One file's measured ranges (240-320 outer, 257-300 nested), plus a block past both and a json chunk. */
const STORED: StoredChunk[] = [
  { id: "head", relativePath: WALKER, startLine: 240, endLine: 256, symbolId: OUTER },
  { id: "nested", relativePath: WALKER, startLine: 282, endLine: 303, symbolId: `${OUTER}#part2` },
  { id: "block", relativePath: WALKER, startLine: 321, endLine: 330 },
  { id: "json", relativePath: CONFIG, startLine: 1, endLine: 10 },
];

type ProducerName = "deferred chunk pass" | "backfiller" | "recovery in-place heal" | "payload heal";
type ScenarioName = "ranges known" | "walked file without ranges" | "pre-024 persisted rows";

/** An owner's signals, a bare `enrichedAt` stamp, or no chunk payload at all. */
type ExpectedChunkPayload = { pageRank: number } | "bare" | "untouched";

interface ProducerCell {
  scenario: ScenarioName;
  producer: ProducerName;
  expected: Record<StoredChunk["id"], ExpectedChunkPayload>;
}

const COMPUTED = { head: { pageRank: 0.1 }, nested: { pageRank: 0.3 }, block: "bare", json: "bare" } as const;
const RECOVERY = { head: "untouched", nested: "untouched", block: "untouched", json: "bare" } as const;

const CELLS: ProducerCell[] = [
  { scenario: "ranges known", producer: "deferred chunk pass", expected: COMPUTED },
  { scenario: "ranges known", producer: "backfiller", expected: COMPUTED },
  { scenario: "ranges known", producer: "recovery in-place heal", expected: RECOVERY },
  {
    scenario: "ranges known",
    producer: "payload heal",
    expected: { head: { pageRank: 0.1 }, nested: { pageRank: 0.3 }, block: "untouched", json: "untouched" },
  },
  {
    scenario: "walked file without ranges",
    producer: "deferred chunk pass",
    expected: { head: "untouched", nested: "untouched", block: "untouched", json: "bare" },
  },
  {
    scenario: "walked file without ranges",
    producer: "backfiller",
    expected: { head: "untouched", nested: "untouched", block: "untouched", json: "bare" },
  },
  { scenario: "walked file without ranges", producer: "recovery in-place heal", expected: RECOVERY },
  // A walk's ranges are the run's own; rows on disk never override them.
  { scenario: "pre-024 persisted rows", producer: "deferred chunk pass", expected: COMPUTED },
  { scenario: "pre-024 persisted rows", producer: "backfiller", expected: COMPUTED },
  { scenario: "pre-024 persisted rows", producer: "recovery in-place heal", expected: RECOVERY },
  {
    scenario: "pre-024 persisted rows",
    producer: "payload heal",
    expected: { head: "untouched", nested: "untouched", block: "untouched", json: "untouched" },
  },
];

function walkerChunk(symbolId: string, startLine: number, endLine: number): ChunkExtraction {
  return { symbolId, scope: [], calls: [], startLine, endLine };
}

function chunkMapOf(chunks: readonly StoredChunk[]): Map<string, ChunkLookupEntry[]> {
  const map = new Map<string, ChunkLookupEntry[]>();
  for (const { id, relativePath, startLine, endLine, symbolId } of chunks) {
    const entries = map.get(relativePath) ?? [];
    entries.push({ chunkId: id, startLine, endLine, ...(symbolId !== undefined ? { symbolId } : {}) });
    map.set(relativePath, entries);
  }
  return map;
}

function chunkItemOf({ id, relativePath, startLine, endLine, symbolId }: StoredChunk): ChunkItem {
  return {
    type: "upsert",
    id,
    chunkId: id,
    codebasePath: ROOT,
    chunk: {
      content: "",
      startLine,
      endLine,
      metadata: {
        filePath: `${ROOT}/${relativePath}`,
        language: "typescript",
        chunkIndex: 0,
        ...(symbolId !== undefined ? { symbolId } : {}),
      },
    },
  } as ChunkItem;
}

describe("codegraph chunk signal producers × range sources (bd tea-rags-mcp-39xca.2)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;
  let qdrant: MockQdrantManager;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-chunk-producers-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    qdrant = new MockQdrantManager();
    await qdrant.addPoints(
      COLL,
      STORED.map(({ id, ...payload }) => ({ id, vector: [0], payload: { ...payload } })),
    );
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function newProvider(): CodegraphEnrichmentProvider {
    return new CodegraphEnrichmentProvider({
      graphDb: client,
      symbolTable: new InMemoryGlobalSymbolTable(),
      ...buildTestCodegraphDeps(new Map([["typescript", new TSCallResolver({ baseUrl: ".", paths: {} })]])),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    });
  }

  /** Walk walker.ts as a run on COLL would, then give each symbol a distinguishable PageRank. */
  async function walk(provider: CodegraphEnrichmentProvider): Promise<void> {
    const sink = provider.asExtractionSink(COLL);
    await sink.write({
      relPath: WALKER,
      language: "typescript",
      imports: [],
      chunks: [walkerChunk(OUTER, 240, 320), walkerChunk(NESTED, 257, 300)],
      fileScope: [],
    });
    await sink.finish();
    await client.replacePageRanks(
      new Map([
        [OUTER, 0.1],
        [NESTED, 0.3],
      ]),
    );
  }

  /** The provider each scenario hands its producers. */
  const SCENARIOS: Record<ScenarioName, () => Promise<CodegraphEnrichmentProvider>> = {
    "ranges known": async () => {
      const provider = newProvider();
      await walk(provider);
      return provider;
    },
    // The graph was walked, but the provider serving this pass holds no line
    // index for the file — a walk that threw, or run state a crash took with it.
    "walked file without ranges": async () => {
      await walk(newProvider());
      return newProvider();
    },
    "pre-024 persisted rows": async () => {
      const provider = newProvider();
      await walk(provider);
      await client.run("UPDATE cg_symbols SET start_line = NULL, end_line = NULL WHERE rel_path = ?", [WALKER]);
      return provider;
    },
  };

  function contextFor(provider: CodegraphEnrichmentProvider) {
    return { key: PROVIDER_KEY, provider, effectiveRoot: ROOT, ignoreFilter: null };
  }

  /** Runs one producer; returns the relPaths it handed off instead of computing. */
  const PRODUCERS: Record<ProducerName, (provider: CodegraphEnrichmentProvider) => Promise<string[]>> = {
    "deferred chunk pass": async (provider) => {
      const ctx = contextFor(provider);
      const phase = new ChunkPhase(new EnrichmentApplier(qdrant as never), new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]) as never, COLL, ENRICHED_AT);
      await phase.runDeferredChunk(COLL, ctx as never, ROOT, chunkMapOf(STORED));
      return [];
    },
    backfiller: async (provider) => {
      const applier = new EnrichmentApplier(qdrant as never);
      // Every file registered as missed, the way a run's file apply does it.
      await applier.applyFileSignals(COLL, PROVIDER_KEY, new Map(), ROOT, STORED.map(chunkItemOf));
      const inline = new InlineEnrichmentExecutor();
      // The file half is not under test; the chunk half reaches the real provider.
      const executor = {
        runFileSignalsRecovery: async (_provider: unknown, _root: string, paths: string[]) =>
          new Map(paths.map((path) => [path, {}])),
        runChunkBatch: async (...args: Parameters<InlineEnrichmentExecutor["runChunkBatch"]>) =>
          inline.runChunkBatch(...args),
      };
      await new EnrichmentBackfiller(applier, qdrant as never, executor as never).runFor(
        COLL,
        contextFor(provider) as never,
        ENRICHED_AT,
      );
      return [];
    },
    "recovery in-place heal": async (provider) => {
      const recovery = new EnrichmentRecovery(qdrant as never, new EnrichmentApplier(qdrant as never));
      const result = await recovery.recoverChunkLevel(COLL, ROOT, provider, ENRICHED_AT);
      return [...(result.deferredChunks?.keys() ?? [])];
    },
    "payload heal": async () => {
      const drift = {
        symbols: [
          { relPath: WALKER, symbolId: OUTER },
          { relPath: WALKER, symbolId: NESTED },
        ],
        files: [],
      };
      const graphDb = {
        diffSymbolSignals: async () => Promise.resolve(drift),
        refreshSymbolSignalsPrev: async () => Promise.resolve(),
        getFanInP95: async () => client.getFanInP95(),
        getFileMetricsBulk: async (paths: readonly string[]) => client.getFileMetricsBulk(paths),
        getChunkSignalsBulk: async () => client.getChunkSignalsBulk(),
        getSymbolLineRangesBulk: async (paths: readonly string[]) => client.getSymbolLineRangesBulk(paths),
      };
      const healQdrant = {
        countPoints: async (collectionName: string) => qdrant.countPoints(collectionName),
        scrollFiltered: async () => Promise.reject(new Error("a four-point collection takes the streaming pass")),
        async *scrollPayloadPages(collectionName: string) {
          yield await qdrant.scrollFiltered(collectionName, {}, STORED.length);
        },
        batchSetPayload: async (collectionName: string, operations: BatchPayloadOp[]) =>
          qdrant.batchSetPayload(collectionName, operations),
      };
      await createCodegraphPayloadHealRunner({
        qdrant: healQdrant as never,
        acquireGraphDb: async () => Promise.resolve(graphDb as unknown as GraphDbClient),
        providerKey: PROVIDER_KEY,
      }).run(COLL, new Set(), ENRICHED_AT);
      return [];
    },
  };

  async function chunkPayloadOf(id: string): Promise<Record<string, unknown> | undefined> {
    const point = await qdrant.getPoint(COLL, id);
    const codegraph = point?.payload?.codegraph as { symbols?: { chunk?: Record<string, unknown> } } | undefined;
    return codegraph?.symbols?.chunk;
  }

  it.each(CELLS)("$scenario — $producer", async ({ scenario, producer, expected }) => {
    const provider = await SCENARIOS[scenario]();

    const handedOff = await PRODUCERS[producer](provider);

    for (const [id, want] of Object.entries(expected)) {
      const payload = await chunkPayloadOf(id);
      if (want === "untouched") {
        expect(payload, `${id} must carry no chunk payload`).toBeUndefined();
      } else if (want === "bare") {
        expect(payload, `${id} must be stamped without signal values`).toEqual({ enrichedAt: ENRICHED_AT });
      } else {
        expect(payload, `${id} must carry its owner's signals`).toEqual({
          fanIn: 0,
          fanOut: 0,
          pageRank: want.pageRank,
          enrichedAt: ENRICHED_AT,
        });
      }
    }
    expect(handedOff).toEqual(producer === "recovery in-place heal" ? [WALKER] : []);
  });
});
