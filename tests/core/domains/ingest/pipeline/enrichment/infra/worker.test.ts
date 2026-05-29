/**
 * Phase 2 Task 4b — enrichment worker entry contract.
 *
 * The worker thread receives serializable call / release envelopes,
 * dynamic-imports the named factory export, builds + caches a provider
 * instance per (providerModulePath, collectionName), and dispatches to
 * the named provider method. Mirrors `chunker/infra/worker.ts` pattern
 * (dynamic-import via injected module path, no static cross-domain
 * import, per-thread engine cache).
 *
 * Tests use a real worker_threads.Worker against a fixture provider
 * factory module written to a temp file — the worker is the value, not
 * the dispatch logic, so mocking it would defeat the point.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-protocol.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WORKER_PATH = resolve(
  __dirname,
  "../../../../../../../build/core/domains/ingest/pipeline/enrichment/infra/worker.js",
);

/**
 * Fixture provider factory module written to a temp file. The worker
 * dynamic-imports this path and calls `createFakeProvider(config)` to
 * build the provider instance. The provider is intentionally minimal:
 * tracks how many times each method was called via a per-instance
 * counter stored in `(provider as any).__calls`. Tests assert call
 * routing by reading these counters via behavior — overlay maps echo
 * the config + collection name so requests are traceable.
 */
const FIXTURE_PROVIDER_SRC = `
export async function createFakeProvider(config) {
  const calls = { runFileBatch: 0, runChunkBatch: 0, runFinalize: 0, onRelease: 0 };
  const tag = config.tag ?? "fake";
  return {
    key: "fake",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: async (root, options) => {
      calls.runFileBatch++;
      const out = new Map();
      out.set("a.ts", { source: tag, root, paths: options?.paths ?? [] });
      return out;
    },
    streamFileBatch: async (root, paths, options) => {
      calls.runFileBatch++;
      const out = new Map();
      for (const p of paths) {
        out.set(p, { source: tag, root, options });
      }
      return out;
    },
    buildChunkSignals: async (root, chunkMap, options) => {
      calls.runChunkBatch++;
      const out = new Map();
      for (const [file, entries] of chunkMap) {
        const inner = new Map();
        for (const e of entries) inner.set(e.chunkId, { source: tag, line: e.startLine });
        out.set(file, inner);
      }
      return out;
    },
    finalizeSignals: async (root) => {
      calls.runFinalize++;
      return new Map([["final.ts", { source: tag, finalized: true }]]);
    },
    onRelease: async () => {
      calls.onRelease++;
    },
    __calls: calls,
  };
}
`;

type ResponseAcc = (msg: EnrichmentWorkerResponse) => void;

async function postAndCollect(worker: Worker, request: EnrichmentWorkerRequest): Promise<EnrichmentWorkerResponse> {
  return new Promise((resolveResult, reject) => {
    const handler: ResponseAcc = (msg) => {
      worker.off("message", handler);
      resolveResult(msg);
    };
    worker.on("message", handler);
    worker.on("error", (err) => {
      reject(err);
    });
    worker.postMessage(request);
  });
}

async function shutdownWorker(worker: Worker): Promise<void> {
  worker.postMessage({ type: "shutdown" });
  await new Promise<void>((res) => {
    worker.once("exit", () => {
      res();
    });
    // Safety: terminate after 2s if the graceful close hangs.
    setTimeout(
      () =>
        void worker.terminate().then(() => {
          res();
        }),
      2000,
    ).unref();
  });
}

describe("enrichment worker entry", () => {
  let tmp: string;
  let fixturePath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "enrich-worker-"));
    fixturePath = join(tmp, "fixture-provider.mjs");
    writeFileSync(fixturePath, FIXTURE_PROVIDER_SRC);
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dispatches a `call` request to runFileBatch and returns the overlay", async () => {
    const worker = new Worker(WORKER_PATH);
    const response = await postAndCollect(worker, {
      type: "call",
      providerModulePath: fixturePath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "alpha" },
      collectionName: "code_xxx",
      method: "runFileBatch",
      root: "/repo",
      paths: ["a.ts", "b.ts"],
    });
    expect(response.error).toBeUndefined();
    expect(response.fileOverlay).toBeDefined();
    const overlay = response.fileOverlay!;
    expect(overlay.get("a.ts")).toMatchObject({ source: "alpha", root: "/repo" });
    expect(overlay.get("b.ts")).toMatchObject({ source: "alpha", root: "/repo" });
    await shutdownWorker(worker);
  });

  it("falls back to buildFileSignals when streamFileBatch is unavailable", async () => {
    // Override the fixture to make streamFileBatch absent.
    const noStreamPath = join(tmp, "no-stream-provider.mjs");
    writeFileSync(noStreamPath, FIXTURE_PROVIDER_SRC.replace("streamFileBatch:", "_disabledStream:"));
    const worker = new Worker(WORKER_PATH);
    const response = await postAndCollect(worker, {
      type: "call",
      providerModulePath: noStreamPath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "beta" },
      collectionName: "code_xxx",
      method: "runFileBatch",
      root: "/repo",
      paths: ["x.ts"],
    });
    expect(response.error).toBeUndefined();
    expect(response.fileOverlay!.get("a.ts")).toMatchObject({ source: "beta", root: "/repo" });
    await shutdownWorker(worker);
  });

  it("dispatches runChunkBatch with nested-map round-trip", async () => {
    const worker = new Worker(WORKER_PATH);
    const chunkMap = new Map([["a.ts", [{ chunkId: "c1", startLine: 10, endLine: 20 }]]]);
    const response = await postAndCollect(worker, {
      type: "call",
      providerModulePath: fixturePath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "gamma" },
      collectionName: "code_xxx",
      method: "runChunkBatch",
      root: "/repo",
      chunkMap,
    });
    expect(response.error).toBeUndefined();
    const inner = response.chunkOverlay!.get("a.ts")!;
    expect(inner.get("c1")).toMatchObject({ source: "gamma", line: 10 });
    await shutdownWorker(worker);
  });

  it("dispatches runFinalize and returns the deferred file overlay", async () => {
    const worker = new Worker(WORKER_PATH);
    const response = await postAndCollect(worker, {
      type: "call",
      providerModulePath: fixturePath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "delta" },
      collectionName: "code_xxx",
      method: "runFinalize",
      root: "/repo",
    });
    expect(response.error).toBeUndefined();
    expect(response.fileOverlay!.get("final.ts")).toMatchObject({ finalized: true });
    await shutdownWorker(worker);
  });

  it("caches the provider per (modulePath, collectionName) across calls and releases via release envelope", async () => {
    const worker = new Worker(WORKER_PATH);
    // First call builds and caches.
    await postAndCollect(worker, {
      type: "call",
      providerModulePath: fixturePath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "first" },
      collectionName: "code_persistent",
      method: "runFileBatch",
      root: "/repo",
      paths: ["a.ts"],
    });
    // Second call MUST use the SAME provider instance (config "first") even
    // though we pass a different serializableConfig in this envelope —
    // the cache key is (modulePath, collectionName), not config. Proves
    // the worker doesn't naïvely rebuild on every call.
    const second = await postAndCollect(worker, {
      type: "call",
      providerModulePath: fixturePath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "ignored" },
      collectionName: "code_persistent",
      method: "runFileBatch",
      root: "/repo",
      paths: ["b.ts"],
    });
    expect(second.fileOverlay!.get("b.ts")).toMatchObject({ source: "first" });
    // Release envelope evicts the cache entry. Subsequent call rebuilds
    // with the FRESH config.
    const releaseResponse = await postAndCollect(worker, {
      type: "release",
      providerModulePath: fixturePath,
      collectionName: "code_persistent",
    });
    expect(releaseResponse.error).toBeUndefined();
    expect(releaseResponse.released).toBe(true);
    const third = await postAndCollect(worker, {
      type: "call",
      providerModulePath: fixturePath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: { tag: "rebuilt" },
      collectionName: "code_persistent",
      method: "runFileBatch",
      root: "/repo",
      paths: ["c.ts"],
    });
    expect(third.fileOverlay!.get("c.ts")).toMatchObject({ source: "rebuilt" });
    await shutdownWorker(worker);
  });

  it("returns error envelope when factory throws", async () => {
    const brokenPath = join(tmp, "broken-provider.mjs");
    writeFileSync(brokenPath, "export async function createFakeProvider() { throw new Error('boom'); }");
    const worker = new Worker(WORKER_PATH);
    const response = await postAndCollect(worker, {
      type: "call",
      providerModulePath: brokenPath,
      providerFactoryExport: "createFakeProvider",
      serializableConfig: {},
      collectionName: "code_xxx",
      method: "runFileBatch",
      root: "/repo",
      paths: ["a.ts"],
    });
    expect(response.error).toMatch(/boom/);
    expect(response.fileOverlay).toBeUndefined();
    await shutdownWorker(worker);
  });

  it("release on uncached entry is a benign no-op", async () => {
    const worker = new Worker(WORKER_PATH);
    const response = await postAndCollect(worker, {
      type: "release",
      providerModulePath: fixturePath,
      collectionName: "never-cached",
    });
    expect(response.error).toBeUndefined();
    expect(response.released).toBe(false);
    await shutdownWorker(worker);
  });
});
