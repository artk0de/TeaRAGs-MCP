/**
 * Pass-1 extraction fan-out through the REAL enrichment pool.
 *
 * The unit tests beside this file pin the split/gather protocol against a fake
 * pool; this one answers the question only real threads can: does the extraction
 * actually leave the pinned worker, and does everything stateful stay on it?
 *
 * The fixture provider stamps `threadId` into every record it produces, so a
 * single finalize read-back reports which threads parsed and which thread
 * absorbed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  EnrichmentProvider,
  WorkerEnrichmentDescriptor,
} from "../../../../../../../src/core/contracts/types/provider.js";
import { WorkerPoolEnrichmentExecutor } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WORKER_PATH = resolve(
  __dirname,
  "../../../../../../../build/core/domains/ingest/pipeline/enrichment/infra/worker.js",
);

/**
 * Provider whose extraction records carry the parsing thread's id, and whose
 * finalize reports what THIS thread absorbed. `language` is the carrier for the
 * thread id because it survives the structured-clone boundary unchanged.
 */
const FANOUT_PROVIDER_SRC = `import { threadId } from "node:worker_threads";
const absorbed = [];
const streamed = [];
export async function createTaggedProvider(_config) {
  return {
    key: "fanout-spy",
    signals: [], derivedSignals: [], filters: [], presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
    streamFileBatch: async (_root, paths) => {
      for (const p of paths) streamed.push(p);
      return new Map();
    },
    extractFileBatch: async (_root, paths) => ({
      extractions: paths.map((relPath) => ({
        relPath,
        language: String(threadId),
        imports: [], chunks: [], fileScope: [],
      })),
      pass1ByLanguage: { typescript: { ms: 5, files: paths.length } },
    }),
    absorbExtractedFiles: async (_root, extractions) => {
      for (const e of extractions) absorbed.push({ relPath: e.relPath, extractThread: e.language });
    },
    finalizeSignals: async () => new Map([
      ["report", { absorbThread: threadId, absorbed, streamed }],
    ]),
  };
}`;

interface FanoutReport {
  absorbThread: number;
  absorbed: { relPath: string; extractThread: string }[];
  streamed: string[];
}

function fanoutProvider(modulePath: string): EnrichmentProvider {
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: modulePath,
    providerFactoryExport: "createTaggedProvider",
    dispatch: "collection-affinity",
    extractionFanout: true,
    serializableConfig: {},
  };
  return {
    key: "fanout-spy",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
    streamFileBatch: async () => new Map(),
    workerDescriptor: descriptor,
  } as unknown as EnrichmentProvider;
}

function paths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/f${i}.ts`);
}

async function report(exec: WorkerPoolEnrichmentExecutor, provider: EnrichmentProvider, coll: string) {
  const out = await exec.runFinalize(provider, "/repo", { collectionName: coll });
  return out.get("report") as unknown as FanoutReport;
}

describe("WorkerPoolEnrichmentExecutor — pass-1 extraction fan-out", () => {
  let tmp: string;
  let fixturePath: string;
  const executors: WorkerPoolEnrichmentExecutor[] = [];

  const executor = (poolSize: number): WorkerPoolEnrichmentExecutor => {
    const exec = new WorkerPoolEnrichmentExecutor(poolSize, WORKER_PATH);
    executors.push(exec);
    return exec;
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "wpex-fanout-"));
    fixturePath = join(tmp, "fanout-provider.mjs");
    writeFileSync(fixturePath, FANOUT_PROVIDER_SRC);
  });

  afterEach(async () => {
    delete process.env.CODEGRAPH_PASS1_FANOUT;
    await Promise.all(executors.splice(0).map(async (exec) => exec.shutdown()));
  });

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses on several workers and absorbs on exactly one", async () => {
    const exec = executor(4);
    const provider = fanoutProvider(fixturePath);
    const batch = paths(40);

    await exec.runFileBatch(provider, "/repo", batch, { collectionName: "code_fanout" });
    const result = await report(exec, provider, "code_fanout");

    // Every file reached the pinned worker exactly once, in batch order.
    expect(result.absorbed.map((a) => a.relPath)).toEqual(batch);
    // …and was parsed somewhere else: more than one thread produced records.
    const parsingThreads = new Set(result.absorbed.map((a) => a.extractThread));
    expect(parsingThreads.size).toBeGreaterThan(1);
    // The stateful half never ran on the extraction path.
    expect(result.streamed).toEqual([]);
  });

  it("keeps the batch on the pinned worker when the kill-switch is set", async () => {
    process.env.CODEGRAPH_PASS1_FANOUT = "0";
    const exec = executor(4);
    const provider = fanoutProvider(fixturePath);
    const batch = paths(40);

    await exec.runFileBatch(provider, "/repo", batch, { collectionName: "code_off" });
    const result = await report(exec, provider, "code_off");

    expect(result.streamed).toEqual(batch);
    expect(result.absorbed).toEqual([]);
  });

  it("leaves a cross-pass run alone — its extraction comes from the chunker", async () => {
    const exec = executor(4);
    const provider = fanoutProvider(fixturePath);
    const batch = paths(40);

    await exec.runFileBatch(provider, "/repo", batch, { collectionName: "code_xpass", crossPass: true });
    const result = await report(exec, provider, "code_xpass");

    expect(result.streamed).toEqual(batch);
    expect(result.absorbed).toEqual([]);
  });

  it("extracts a path once per run and re-extracts it after the next beginRun", async () => {
    const exec = executor(4);
    const provider = fanoutProvider(fixturePath);

    await exec.runFileBatch(provider, "/repo", paths(20), { collectionName: "code_dedup" });
    await exec.runFileBatch(provider, "/repo", paths(20), { collectionName: "code_dedup" });
    const first = await report(exec, provider, "code_dedup");
    expect(first.absorbed.map((a) => a.relPath)).toEqual(paths(20));

    exec.beginRun("code_dedup");
    await exec.runFileBatch(provider, "/repo", paths(20), { collectionName: "code_dedup" });
    const second = await report(exec, provider, "code_dedup");
    expect(second.absorbed.map((a) => a.relPath)).toEqual([...paths(20), ...paths(20)]);
  });

  it("does not fan out a provider that has not declared it", async () => {
    const exec = executor(4);
    const provider = fanoutProvider(fixturePath);
    const descriptor = provider.workerDescriptor as WorkerEnrichmentDescriptor;
    const undeclared = {
      ...provider,
      workerDescriptor: { ...descriptor, extractionFanout: false },
    } as EnrichmentProvider;

    await exec.runFileBatch(undeclared, "/repo", paths(40), { collectionName: "code_undeclared" });
    const result = await report(exec, undeclared, "code_undeclared");

    expect(result.streamed).toEqual(paths(40));
    expect(result.absorbed).toEqual([]);
  });
});
