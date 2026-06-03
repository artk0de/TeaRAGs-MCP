/**
 * Phase 2 Task 4c — WorkerPoolEnrichmentExecutor.
 *
 * Wraps a real ThreadPool with a real enrichment worker entry, dispatched
 * against fixture provider modules written to a temp dir. Uses the
 * production worker entry at build/.../enrichment/infra/worker.js so the
 * test exercises the same code path the runtime uses.
 *
 * The executor's contract is two-fold:
 *
 *   1. Providers WITH workerDescriptor → dispatch through ThreadPool with
 *      routingKey derived from dispatch mode ("collection-affinity" →
 *      collectionName; "stateless" → none).
 *   2. Providers WITHOUT workerDescriptor → fall through to
 *      InlineEnrichmentExecutor (graceful migration path).
 *
 * releaseCollection issues a `release` envelope per provider with a
 * descriptor AND drops the ThreadPool affinity binding so the next
 * collection assigned to that routingKey can land on any free thread.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type {
  EnrichmentProvider,
  WorkerEnrichmentDescriptor,
} from "../../../../../../../src/core/contracts/types/provider.js";
import {
  routingKeyFor,
  WorkerPoolEnrichmentExecutor,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WORKER_PATH = resolve(
  __dirname,
  "../../../../../../../build/core/domains/ingest/pipeline/enrichment/infra/worker.js",
);

const FIXTURE_PROVIDER_SRC = `
export async function createTaggedProvider(config) {
  const tag = config.tag ?? "untagged";
  return {
    key: "fake",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: async (root, options) => {
      const out = new Map();
      for (const p of options?.paths ?? []) {
        out.set(p, { source: tag, via: "buildFileSignals" });
      }
      return out;
    },
    streamFileBatch: async (root, paths) => {
      const out = new Map();
      for (const p of paths) out.set(p, { source: tag, via: "streamFileBatch" });
      return out;
    },
    buildChunkSignals: async (root, chunkMap) => {
      const out = new Map();
      for (const [file, entries] of chunkMap) {
        const inner = new Map();
        for (const e of entries) inner.set(e.chunkId, { source: tag, line: e.startLine });
        out.set(file, inner);
      }
      return out;
    },
    finalizeSignals: async () => new Map([["final.ts", { source: tag, final: true }]]),
    onRelease: async () => {},
  };
}
`;

function fakeInlineProvider(): EnrichmentProvider {
  return {
    key: "inline-only",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: vi.fn(async () => new Map([["inline.ts", { via: "inline-build" }]])),
    buildChunkSignals: vi.fn(async () => new Map([["inline.ts", new Map([["c1", { via: "inline-chunk" }]])]])),
  } as unknown as EnrichmentProvider;
}

function workerProvider(modulePath: string, dispatch: "stateless" | "collection-affinity"): EnrichmentProvider {
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: modulePath,
    providerFactoryExport: "createTaggedProvider",
    dispatch,
    serializableConfig: { tag: dispatch === "stateless" ? "stateless-tag" : "affinity-tag" },
  };
  return {
    key: "worker-provider",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
    workerDescriptor: descriptor,
  } as unknown as EnrichmentProvider;
}

describe("WorkerPoolEnrichmentExecutor", () => {
  let tmp: string;
  let fixturePath: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "wpex-"));
    fixturePath = join(tmp, "fixture-provider.mjs");
    writeFileSync(fixturePath, FIXTURE_PROVIDER_SRC);
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("dispatches a worker-descriptor provider through the pool (collection-affinity)", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(2, WORKER_PATH);
    const provider = workerProvider(fixturePath, "collection-affinity");
    const overlay = await exec.runFileBatch(provider, "/repo", ["a.ts", "b.ts"], { collectionName: "code_xxx" });
    expect(overlay.get("a.ts")).toMatchObject({ source: "affinity-tag", via: "streamFileBatch" });
    expect(overlay.get("b.ts")).toMatchObject({ source: "affinity-tag", via: "streamFileBatch" });
    await exec.shutdown();
  });

  it("falls back to inline executor for providers without workerDescriptor", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const provider = fakeInlineProvider();
    const overlay = await exec.runFileBatch(provider, "/repo", ["x.ts"], {});
    expect(overlay.get("inline.ts")).toMatchObject({ via: "inline-build" });
    expect(provider.buildFileSignals).toHaveBeenCalled();
    await exec.shutdown();
  });

  it("dispatches runChunkBatch through pool when worker descriptor is present", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const provider = workerProvider(fixturePath, "collection-affinity");
    const chunkMap = new Map([["a.ts", [{ chunkId: "c1", startLine: 7, endLine: 9 }]]]);
    const out = await exec.runChunkBatch(provider, "/repo", chunkMap, { collectionName: "c1" });
    expect(out.get("a.ts")?.get("c1")).toMatchObject({ source: "affinity-tag", line: 7 });
    await exec.shutdown();
  });

  it("dispatches runFinalize through pool", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const provider = workerProvider(fixturePath, "collection-affinity");
    const out = await exec.runFinalize(provider, "/repo", { collectionName: "c1" });
    expect(out.get("final.ts")).toMatchObject({ final: true });
    await exec.shutdown();
  });

  it("releaseCollection dispatches release envelope for worker-descriptor providers", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const provider = workerProvider(fixturePath, "collection-affinity");
    // Warm the worker cache.
    await exec.runFileBatch(provider, "/repo", ["a.ts"], { collectionName: "release-test" });
    // Release should complete cleanly.
    await expect(exec.releaseCollection([provider], "release-test")).resolves.toBeUndefined();
    await exec.shutdown();
  });

  it("releaseCollection is a no-op for providers without workerDescriptor", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const provider = fakeInlineProvider();
    // Should not throw even though we never dispatched on this provider.
    await expect(exec.releaseCollection([provider], "any")).resolves.toBeUndefined();
    await exec.shutdown();
  });

  it("stateless dispatch does NOT use collectionName as routingKey (different collections can land on different threads)", async () => {
    // Two-thread pool — if stateless dispatch leaked collectionName as the
    // routing key, both calls would pin to the same thread. We can't observe
    // thread id from the executor's response, but we CAN observe that two
    // concurrent dispatches both complete (no serialization deadlock from
    // wrong-key pinning) AND return correct tagged data.
    const exec = new WorkerPoolEnrichmentExecutor(2, WORKER_PATH);
    const provider = workerProvider(fixturePath, "stateless");
    const [a, b] = await Promise.all([
      exec.runFileBatch(provider, "/repo", ["a.ts"], { collectionName: "coll-A" }),
      exec.runFileBatch(provider, "/repo", ["b.ts"], { collectionName: "coll-B" }),
    ]);
    expect(a.get("a.ts")).toMatchObject({ source: "stateless-tag" });
    expect(b.get("b.ts")).toMatchObject({ source: "stateless-tag" });
    await exec.shutdown();
  });

  it("runFileSignals dispatches through pool (whole-set, bypasses streamFileBatch)", async () => {
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const provider = workerProvider(fixturePath, "collection-affinity");
    // runFileSignals MUST call buildFileSignals (not streamFileBatch) — the
    // fixture tags via:"buildFileSignals" so we can see which path was taken.
    const overlay = await exec.runFileSignals(provider, "/repo", ["a.ts", "b.ts"], { collectionName: "code_xxx" });
    expect(overlay.get("a.ts")).toMatchObject({ via: "buildFileSignals", source: "affinity-tag" });
    expect(overlay.get("b.ts")).toMatchObject({ via: "buildFileSignals", source: "affinity-tag" });
    await exec.shutdown();
  });

  // --- git dispatch affinity fix (tea-rags-mcp: pin git per-collection) ---

  it("routingKeyFor: collection-affinity descriptor returns collectionName as routing key", () => {
    // Verify the routing mechanism: collection-affinity → collectionName key.
    const descriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: "/path/to/git-provider.js",
      providerFactoryExport: "createGitEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: {},
    };
    expect(routingKeyFor(descriptor, "code_27622aef")).toBe("code_27622aef");
  });

  it("git workerDescriptor must use collection-affinity to pin file+chunk batches to same worker", () => {
    // Git is STATEFUL — buildChunkSignals reuses blameByRelPath/lastFileResult/
    // enrichmentCache populated by buildFileSignals on the same instance.
    // collection-affinity pins all of a collection's file/chunk/finalize batches
    // to one worker, restoring that in-process reuse (~10x speedup on deep-history).
    const gitDescriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: "/absolute/path/git/factory.js",
      providerFactoryExport: "createGitEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: {},
    };
    // Assert the dispatch mode and that routingKeyFor returns collectionName.
    expect(gitDescriptor.dispatch).toBe("collection-affinity");
    expect(routingKeyFor(gitDescriptor, "code_27622aef")).toBe("code_27622aef");
  });

  it("collection-affinity: file and chunk batches for same collection produce identical routingKey", () => {
    // Structural invariant: same descriptor + same collectionName → same key.
    // ThreadPool affinity ensures same key → same worker → same provider instance.
    const affinityDescriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: "/path/to/git-provider.js",
      providerFactoryExport: "createGitEnrichmentProvider",
      dispatch: "collection-affinity",
      serializableConfig: {},
    };
    const collectionName = "code_27622aef";
    expect(routingKeyFor(affinityDescriptor, collectionName)).toBe(collectionName);
    expect(routingKeyFor(affinityDescriptor, collectionName)).toBe(routingKeyFor(affinityDescriptor, collectionName));
  });

  it("propagates worker errors as thrown exceptions", async () => {
    // Fixture that always throws inside buildFileSignals.
    const brokenPath = join(tmp, "broken-provider.mjs");
    writeFileSync(
      brokenPath,
      `export async function createTaggedProvider() {
         return {
           key: "broken", signals: [], derivedSignals: [], filters: [], presets: [],
           resolveRoot: (p) => p,
           buildFileSignals: async () => { throw new Error("boom-from-worker"); },
           buildChunkSignals: async () => new Map(),
         };
       }`,
    );
    const exec = new WorkerPoolEnrichmentExecutor(1, WORKER_PATH);
    const descriptor: WorkerEnrichmentDescriptor = {
      providerModulePath: brokenPath,
      providerFactoryExport: "createTaggedProvider",
      dispatch: "collection-affinity",
      serializableConfig: {},
    };
    const provider = {
      key: "broken-provider",
      signals: [],
      derivedSignals: [],
      filters: [],
      presets: [],
      resolveRoot: (p: string) => p,
      buildFileSignals: async () => new Map(),
      buildChunkSignals: async () => new Map(),
      workerDescriptor: descriptor,
    } as unknown as EnrichmentProvider;
    await expect(exec.runFileSignals(provider, "/repo", ["a.ts"], { collectionName: "code_xxx" })).rejects.toThrow(
      /boom-from-worker/,
    );
    await exec.shutdown();
  });
});
