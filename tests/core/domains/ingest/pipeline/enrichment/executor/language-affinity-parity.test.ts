/**
 * Offline acceptance for per-language codegraph affinity (bd tea-rags-mcp-sgo8v):
 * two absorb pipelines writing disjoint files into ONE graph database leave
 * exactly the graph collection affinity leaves.
 *
 * Everything but the threads is production code: the executor's real
 * `ExtractionFanoutDispatcher` and `LanguageAffinityDispatcher`, the worker's
 * real `invokeEnrichmentMethod`, the real `CodegraphEnrichmentProvider` over a
 * real DuckDB file. The pool is an in-process router with the worker's own
 * provider-cache key — one provider instance per (collection, partition), each
 * with its own symbol table, all sharing the one database client the way every
 * worker shares the daemon's per-collection connection. Batches are fired
 * without being awaited, as `FilePhase` fires them, so the partitions' absorbs
 * and pass-2 writes genuinely interleave on that connection.
 *
 * The corpus carries cross-language namesakes and a third language sharing a
 * partition (see `mixed-language-corpus.ts`); the provider-level test pins that
 * on it, a partition that did NOT mirror the other languages resolves differently.
 * Parity here is therefore not a property of a corpus that never exercises it.
 *
 * Compared: every row of every `cg_*` table (symbols with their chunk ids, both
 * edge scopes, inheritance, ambiguous fan-out, run stats, per-file resolve stats
 * and coverage, pass-1 aggregates), the file overlays the finalize returns and
 * the chunk overlays the deferred pass returns — byte for byte. Cycles and
 * PageRank are compared by meaning (member sets; values within the adapter's own
 * 1e-12 PageRank epsilon): both are computed from the edge tables in STORAGE
 * order, two interleaved writers store the same rows in a different order, and
 * Tarjan's numbering and a DOUBLE sum follow it — measured, the only difference
 * was 0.27761937783213425 vs …414 on one symbol.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../../../../src/core/adapters/duckdb/client.js";
import type {
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOverlay,
} from "../../../../../../../src/core/contracts/types/provider.js";
import { ExtractionFanoutDispatcher } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/extraction-fanout.js";
import { LanguageAffinityDispatcher } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/language-affinity-dispatch.js";
import {
  planLanguageAffinity,
  type LanguageAffinityPlan,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/language-affinity-plan.js";
import {
  enrichmentProviderCacheKey,
  invokeEnrichmentMethod,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-invoke.js";
import type {
  EnrichmentCallRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-protocol.js";
import { collectSymbols } from "../../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { runMigrations } from "../../../../../../../src/core/domains/maintenance/migration/database/runner.js";
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
import { buildTestCodegraphDeps } from "../../../../trajectory/codegraph/__helpers__/language-factory.js";
import {
  wholeFileChunkMap,
  writeMixedLanguageCorpus,
} from "../../../../trajectory/codegraph/__helpers__/mixed-language-corpus.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../../../../src/core/domains/maintenance/migration/database/migrations");

const COLLECTION = "code_parity_v1";
const MODULE = "codegraph-in-process";
const BATCH_SIZE = 2;

interface RunOutcome {
  tables: Record<string, string[]>;
  fileOverlays: Map<string, FileSignalOverlay>;
  chunkOverlays: Map<string, Map<string, ChunkSignalOverlay>>;
}

/**
 * The in-process pool: routes an envelope to the provider instance a worker
 * would hold for it, and runs it through the worker's own dispatch. Extraction
 * carries no partition and lands on the collection-wide instance, which it
 * never lets touch the store.
 */
function inProcessPool(client: DuckDbGraphClient): {
  dispatch: (request: EnrichmentWorkerRequest, routingKey?: string) => Promise<EnrichmentWorkerResponse>;
} {
  const instances = new Map<string, CodegraphEnrichmentProvider>();
  const dispatch = async (request: EnrichmentWorkerRequest): Promise<EnrichmentWorkerResponse> => {
    if (request.type !== "call") return {};
    const key = enrichmentProviderCacheKey(
      request.providerModulePath,
      request.collectionName,
      request.affinityPartition,
    );
    let provider = instances.get(key);
    if (!provider) {
      provider = new CodegraphEnrichmentProvider({
        graphDb: client,
        symbolTable: new InMemoryGlobalSymbolTable(),
        ...buildTestCodegraphDeps(),
        composer: new DefaultSymbolIdComposer(),
        collectSymbols,
      });
      instances.set(key, provider);
    }
    // Yield first, as a postMessage would: a dispatch never runs inside its caller's turn.
    await Promise.resolve();
    return invokeEnrichmentMethod(provider as EnrichmentProvider, structuredClone(request));
  };
  return { dispatch };
}

function call(method: EnrichmentCallRequest["method"], root: string, extra: Partial<EnrichmentCallRequest> = {}) {
  const request: EnrichmentCallRequest = {
    type: "call",
    providerModulePath: MODULE,
    providerFactoryExport: "unused",
    serializableConfig: {},
    collectionName: COLLECTION,
    method,
    root,
    ...extra,
  };
  return request;
}

function batches(paths: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += BATCH_SIZE) out.push(paths.slice(i, i + BATCH_SIZE));
  return out;
}

function fanoutOver(
  dispatch: (request: EnrichmentWorkerRequest, routingKey?: string) => Promise<EnrichmentWorkerResponse>,
): ExtractionFanoutDispatcher {
  return new ExtractionFanoutDispatcher(dispatch, {
    workerCount: 2,
    shardSize: 128,
    maxInFlightBatches: 2,
    // Every batch fans out, so the collection-affinity baseline takes the same
    // extract/absorb road the partitions take.
    minPathsToFanOut: 1,
  });
}

async function collectionAffinityRun(client: DuckDbGraphClient, root: string, corpus: string[]): Promise<RunOutcome> {
  const { dispatch } = inProcessPool(client);
  const fanout = fanoutOver(dispatch);
  fanout.beginRun(COLLECTION, corpus.length);
  await Promise.all(
    batches(corpus).map(async (paths) => fanout.runFileBatch(call("runFileBatch", root, { paths }), COLLECTION)),
  );
  const finalized = await dispatch(call("runFinalize", root, { options: { runCoverage: "wholeCorpus" } }), COLLECTION);
  const chunks = await dispatch(call("runChunkBatch", root, { chunkMap: wholeFileChunkMap(corpus) }), COLLECTION);
  return {
    tables: await dumpCodegraphTables(client),
    fileOverlays: finalized.fileOverlay ?? new Map(),
    chunkOverlays: chunks.chunkOverlay ?? new Map(),
  };
}

async function languageAffinityRun(
  client: DuckDbGraphClient,
  root: string,
  corpus: string[],
  plan: LanguageAffinityPlan,
): Promise<RunOutcome> {
  const { dispatch } = inProcessPool(client);
  const fanout = fanoutOver(dispatch);
  const partitioned = new LanguageAffinityDispatcher(dispatch);
  fanout.beginRun(COLLECTION, corpus.length);
  await Promise.all(
    batches(corpus).map(async (paths) => fanout.runPartitionedFileBatch(call("runFileBatch", root, { paths }), plan)),
  );
  const finalized = await partitioned.runFinalize(
    call("runFinalize", root, { options: { runCoverage: "wholeCorpus" } }),
    plan,
  );
  const chunks = await partitioned.runChunkBatch(
    call("runChunkBatch", root, { chunkMap: wholeFileChunkMap(corpus) }),
    plan,
  );
  return {
    tables: await dumpCodegraphTables(client),
    fileOverlays: finalized.fileOverlay ?? new Map(),
    chunkOverlays: chunks.chunkOverlay ?? new Map(),
  };
}

function expectSamePageRanks(actual: Map<string, number>, expected: Map<string, number>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [key, value] of expected) {
    expect(Math.abs((actual.get(key) ?? Number.NaN) - value), key).toBeLessThanOrEqual(PAGE_RANK_EPSILON);
  }
}

function withoutPageRank(
  overlays: Map<string, Map<string, ChunkSignalOverlay>>,
): Map<string, Map<string, ChunkSignalOverlay>> {
  return new Map(
    [...overlays].map(([relPath, chunks]) => [
      relPath,
      new Map([...chunks].map(([chunkId, overlay]) => [chunkId, { ...overlay, pageRank: undefined }])),
    ]),
  );
}

function chunkPageRanks(overlays: Map<string, Map<string, ChunkSignalOverlay>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const chunks of overlays.values()) {
    for (const [chunkId, overlay] of chunks) {
      const { pageRank } = overlay as { pageRank?: number };
      if (typeof pageRank === "number") out.set(chunkId, pageRank);
    }
  }
  return out;
}

async function openGraph(dir: string): Promise<DuckDbGraphClient> {
  const client = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
  await client.init();
  await runMigrations(client, MIG_DIR);
  return client;
}

describe("per-language affinity — parity with collection affinity", () => {
  let root: string;
  let affinityDir: string;
  let partitionDir: string;
  let affinityClient: DuckDbGraphClient;
  let partitionClient: DuckDbGraphClient;
  let corpus: string[];

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "lang-affinity-repo-"));
    corpus = writeMixedLanguageCorpus(root);
    affinityDir = mkdtempSync(join(tmpdir(), "lang-affinity-single-"));
    partitionDir = mkdtempSync(join(tmpdir(), "lang-affinity-split-"));
    affinityClient = await openGraph(affinityDir);
    partitionClient = await openGraph(partitionDir);
  });

  afterEach(async () => {
    await affinityClient.close();
    await partitionClient.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(affinityDir, { recursive: true, force: true });
    rmSync(partitionDir, { recursive: true, force: true });
  });

  it("two partitions writing disjoint files leave the graph one worker leaves", async () => {
    const plan = planLanguageAffinity({
      collectionName: COLLECTION,
      runRelPaths: corpus,
      partitionByExtension: CODEGRAPH_LANGUAGE_BY_EXTENSION,
      minFilesPerPartition: 1,
      maxPartitions: 2,
    });
    expect(plan?.partitions.map((p) => p.label)).toEqual(["typescript", "javascript+ruby"]);
    if (!plan) return;

    const single = await collectionAffinityRun(affinityClient, root, corpus);
    const split = await languageAffinityRun(partitionClient, root, corpus, plan);

    // Not vacuous: the graph has every product the comparison claims to cover.
    for (const table of [
      "cg_symbols",
      "cg_symbols_edges_file",
      "cg_symbols_edges_method",
      "cg_symbols_inheritance",
      "cg_symbols_cycles",
      "cg_symbols_metrics",
      "cg_run_stats",
      "cg_file_resolve_stats",
      "cg_pass1_aggregates",
    ]) {
      expect(single.tables[table].length, table).toBeGreaterThan(0);
    }
    // Both partitions resolved something of their own.
    expect(single.tables.cg_run_stats.some((row) => row.includes('"ruby"'))).toBe(true);
    expect(single.tables.cg_run_stats.some((row) => row.includes('"typescript"'))).toBe(true);

    // Byte for byte: every table whose rows are a function of WHAT was written.
    for (const table of Object.keys(single.tables)) {
      if (ORDER_SENSITIVE_ANALYTICS_TABLES.includes(table)) continue;
      expect(split.tables[table], table).toEqual(single.tables[table]);
    }
    // By meaning: the two analytics that also depend on the ORDER the edge rows
    // are stored in — which differs because two writers interleave. Their input,
    // the edge tables, matched byte for byte above.
    expect(cycleMemberSets(split.tables.cg_symbols_cycles)).toEqual(cycleMemberSets(single.tables.cg_symbols_cycles));
    expectSamePageRanks(
      pageRanksBySymbol(split.tables.cg_symbols_metrics),
      pageRanksBySymbol(single.tables.cg_symbols_metrics),
    );

    expect(split.fileOverlays).toEqual(single.fileOverlays);
    expect(withoutPageRank(split.chunkOverlays)).toEqual(withoutPageRank(single.chunkOverlays));
    expectSamePageRanks(chunkPageRanks(split.chunkOverlays), chunkPageRanks(single.chunkOverlays));
  });
});
