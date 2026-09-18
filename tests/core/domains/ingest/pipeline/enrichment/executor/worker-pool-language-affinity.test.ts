/**
 * Per-language affinity through the REAL enrichment pool (bd tea-rags-mcp-sgo8v).
 *
 * The protocol and the parity are pinned without threads beside this file; this
 * one answers what only real threads can: a run that declared its files is
 * served by one pinned worker PER language partition, each absorbing every
 * record while owning only its own; the deferred chunk pass reaches the thread
 * that walked each file; and the kill-switch — or a run that declared nothing —
 * keeps the single collection-affinity worker.
 *
 * The fixture provider stamps `threadId` on everything it records, so one
 * finalize read-back reports which thread absorbed what, as which role.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ChunkLookupEntry } from "../../../../../../../src/core/contracts/types/chunker.js";
import type {
  EnrichmentProvider,
  EnrichmentRunHandle,
  WorkerEnrichmentDescriptor,
} from "../../../../../../../src/core/contracts/types/provider.js";
import { WorkerPoolEnrichmentExecutor } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WORKER_PATH = resolve(
  __dirname,
  "../../../../../../../build/core/domains/ingest/pipeline/enrichment/infra/worker.js",
);

const PARTITION_SPY_SRC = `import { threadId } from "node:worker_threads";
const absorbed = [];
const stages = [];
const languageOf = (p) => (p.endsWith(".ts") ? "typescript" : p.endsWith(".rb") ? "ruby" : "unknown");
export async function createPartitionSpy(_config) {
  return {
    key: "partition-spy",
    signals: [], derivedSignals: [], filters: [], presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: async () => new Map(),
    streamFileBatch: async (_root, paths) => {
      for (const p of paths) absorbed.push({ relPath: p, role: "streamed", thread: threadId });
      return new Map();
    },
    extractFileBatch: async (_root, paths) => ({
      extractions: paths.map((relPath) => ({ relPath, language: languageOf(relPath), imports: [], chunks: [], fileScope: [] })),
      pass1ByLanguage: {},
    }),
    absorbExtractedFiles: async (_root, extractions, options) => {
      extractions.forEach((e, i) => absorbed.push({ relPath: e.relPath, role: options?.absorbRoles?.[i] ?? "own", thread: threadId }));
    },
    finalizeSignals: async (_root, options) => {
      stages.push({ stage: options?.finalizeStage ?? "single", owner: options?.ownsCollectionCompletion === true, thread: threadId });
      if (options?.finalizeStage === "resolve") return new Map();
      return new Map([["report:" + threadId, { absorbed: [...absorbed], stages: [...stages], thread: threadId }]]);
    },
    buildChunkSignals: async (_root, chunkMap) =>
      new Map([...chunkMap.keys()].map((p) => [p, new Map([["thread", { thread: threadId }]])])),
  };
}`;

interface AbsorbRecord {
  relPath: string;
  role: string;
  thread: number;
}

interface ThreadReport {
  absorbed: AbsorbRecord[];
  stages: { stage: string; owner: boolean; thread: number }[];
  thread: number;
}

const TS = Array.from({ length: 12 }, (_, i) => `web/t${i}.ts`);
const RB = Array.from({ length: 8 }, (_, i) => `app/r${i}.rb`);
const RUN_FILES = [...TS, ...RB, "README.md"];
const BATCHES = [RUN_FILES.slice(0, 7), RUN_FILES.slice(7, 14), RUN_FILES.slice(14)];

function spyProvider(modulePath: string, affinity = true): EnrichmentProvider {
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: modulePath,
    providerFactoryExport: "createPartitionSpy",
    dispatch: "collection-affinity",
    extractionFanout: true,
    ...(affinity ? { languageAffinity: { partitionByExtension: { ".ts": "typescript", ".rb": "ruby" } } } : {}),
    serializableConfig: {},
  };
  return {
    key: "partition-spy",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
    streamFileBatch: async () => new Map(),
    workerDescriptor: descriptor,
  } as unknown as EnrichmentProvider;
}

function run(collection: string): EnrichmentRunHandle {
  return { runId: `run-${collection}`, collection, absolutePath: "/repo" } as EnrichmentRunHandle;
}

async function feed(exec: WorkerPoolEnrichmentExecutor, provider: EnrichmentProvider, collection: string) {
  await Promise.all(
    BATCHES.map(async (paths) => exec.runFileBatch(provider, "/repo", paths, { collectionName: collection as never })),
  );
  const overlays = await exec.runFinalize(provider, "/repo", { collectionName: collection as never });
  return [...overlays.values()] as unknown as ThreadReport[];
}

describe("WorkerPoolEnrichmentExecutor — per-language affinity", () => {
  let tmp: string;
  let fixturePath: string;
  const executors: WorkerPoolEnrichmentExecutor[] = [];

  // Five files per thread: the fixture's two languages each clear it.
  const executor = (): WorkerPoolEnrichmentExecutor => {
    const exec = new WorkerPoolEnrichmentExecutor(4, WORKER_PATH, 5);
    executors.push(exec);
    return exec;
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "wpex-lang-affinity-"));
    fixturePath = join(tmp, "partition-spy.mjs");
    writeFileSync(fixturePath, PARTITION_SPY_SRC);
  });

  afterEach(async () => {
    delete process.env.CODEGRAPH_LANGUAGE_AFFINITY;
    await Promise.all(executors.splice(0).map(async (exec) => exec.shutdown()));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("serves a declared mixed-language run with one pinned worker per partition", async () => {
    const exec = executor();
    const provider = spyProvider(fixturePath);
    exec.beginRun(run("code_mixed"), RUN_FILES.length, RUN_FILES);

    const reports = await feed(exec, provider, "code_mixed");

    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((r) => r.thread)).size).toBe(2);
    for (const report of reports) {
      // Every record reached every partition…
      expect(report.absorbed.map((a) => a.relPath).sort()).toEqual([...RUN_FILES].sort());
      // …and each partition owns exactly one language (the file of no language
      // rides with the completion owner).
      const owned = report.absorbed.filter((a) => a.role === "own").map((a) => a.relPath);
      const ownsTypeScript = owned.some((p) => p.endsWith(".ts"));
      expect(owned.sort()).toEqual((ownsTypeScript ? TS : [...RB, "README.md"]).sort());
      // Resolve, then read back — the completion owner flagged on one only.
      expect(report.stages.map((s) => s.stage)).toEqual(["resolve", "readBack"]);
    }
    expect(reports.filter((r) => r.stages.some((s) => s.owner))).toHaveLength(1);
  });

  it("runs each file's deferred chunk pass on the thread that owns it", async () => {
    const exec = executor();
    const provider = spyProvider(fixturePath);
    exec.beginRun(run("code_chunks"), RUN_FILES.length, RUN_FILES);
    const reports = await feed(exec, provider, "code_chunks");
    const ownerThread = new Map<string, number>();
    for (const report of reports) {
      for (const a of report.absorbed) if (a.role === "own") ownerThread.set(a.relPath, report.thread);
    }

    const chunk = (p: string): ChunkLookupEntry[] => [{ chunkId: `${p}#c`, startLine: 1, endLine: 1 }];
    const overlays = await exec.runChunkBatch(provider, "/repo", new Map(RUN_FILES.map((p) => [p, chunk(p)])), {
      collectionName: "code_chunks" as never,
    });

    for (const relPath of RUN_FILES) {
      const { thread } = overlays.get(relPath)?.get("thread") as unknown as { thread: number };
      expect(thread, relPath).toBe(ownerThread.get(relPath));
    }
  });

  it("keeps collection affinity when the kill-switch is set", async () => {
    process.env.CODEGRAPH_LANGUAGE_AFFINITY = "0";
    const exec = executor();
    const provider = spyProvider(fixturePath);
    exec.beginRun(run("code_killed"), RUN_FILES.length, RUN_FILES);

    const reports = await feed(exec, provider, "code_killed");

    expect(reports).toHaveLength(1);
    expect(reports[0].absorbed.some((a) => a.role === "mirror")).toBe(false);
    expect(reports[0].stages.map((s) => s.stage)).toEqual(["single"]);
  });

  it("keeps collection affinity for a run that did not declare its files", async () => {
    const exec = executor();
    const provider = spyProvider(fixturePath);
    exec.beginRun(run("code_undeclared"), RUN_FILES.length);

    const reports = await feed(exec, provider, "code_undeclared");

    expect(reports).toHaveLength(1);
    expect(reports[0].stages.map((s) => s.stage)).toEqual(["single"]);
  });

  it("keeps collection affinity for a provider that did not declare language affinity", async () => {
    const exec = executor();
    const provider = spyProvider(fixturePath, false);
    exec.beginRun(run("code_plain"), RUN_FILES.length, RUN_FILES);

    const reports = await feed(exec, provider, "code_plain");

    expect(reports).toHaveLength(1);
  });
});
