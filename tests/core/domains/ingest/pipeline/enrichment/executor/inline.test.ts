/**
 * InlineEnrichmentExecutor — main-thread executor, exercises the DIP seam.
 *
 * Behavior is intentionally pass-through: each executor method delegates to
 * the corresponding EnrichmentProvider method. Tests verify the delegation
 * (so swapping the inline impl for a worker-pool impl later can rely on the
 * same contract) and the streamFileBatch-preferred fallback the executor
 * inherited from file-phase.ts.
 */
import { describe, expect, it, vi } from "vitest";

import type { EnrichmentProvider } from "../../../../../../../src/core/contracts/index.js";
import { InlineEnrichmentExecutor } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/inline.js";

function fakeProvider(overrides: Partial<EnrichmentProvider> = {}): EnrichmentProvider {
  return {
    key: "fake",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn(async () => new Map([["a.ts", { x: 1 }]])),
    buildChunkSignals: vi.fn(async () => new Map([["a.ts", new Map([["c1", { y: 2 }]])]])),
    streamFileBatch: vi.fn(async () => new Map([["a.ts", { s: 3 }]])),
    finalizeSignals: vi.fn(async () => new Map([["a.ts", { f: 4 }]])),
    ...overrides,
  } as unknown as EnrichmentProvider;
}

describe("InlineEnrichmentExecutor", () => {
  const exec = new InlineEnrichmentExecutor();

  it("runFileBatch prefers streamFileBatch when present", async () => {
    const p = fakeProvider();
    const out = await exec.runFileBatch(p, "/root", ["a.ts"], { collectionName: "c" });
    expect(out.get("a.ts")).toEqual({ s: 3 });
    expect(p.streamFileBatch).toHaveBeenCalledWith("/root", ["a.ts"], { collectionName: "c" });
    expect(p.buildFileSignals).not.toHaveBeenCalled();
  });

  it("runFileBatch falls back to buildFileSignals({paths}) when no streamFileBatch", async () => {
    const p = fakeProvider({ streamFileBatch: undefined });
    const out = await exec.runFileBatch(p, "/root", ["a.ts"], { collectionName: "c" });
    expect(out.get("a.ts")).toEqual({ x: 1 });
    expect(p.buildFileSignals).toHaveBeenCalledWith("/root", { collectionName: "c", paths: ["a.ts"] });
  });

  it("runFileSignals always calls buildFileSignals with paths (no streamFileBatch preference)", async () => {
    // backfiller / recovery semantics: skip the streaming side-effects.
    const p = fakeProvider();
    const out = await exec.runFileSignals(p, "/root", ["a.ts"], { collectionName: "c" });
    expect(out.get("a.ts")).toEqual({ x: 1 });
    expect(p.buildFileSignals).toHaveBeenCalledWith("/root", { collectionName: "c", paths: ["a.ts"] });
    expect(p.streamFileBatch).not.toHaveBeenCalled();
  });

  it("runChunkBatch delegates to buildChunkSignals", async () => {
    const p = fakeProvider();
    const map = new Map([["a.ts", [{ chunkId: "c1", startLine: 1, endLine: 2 }]]]);
    const out = await exec.runChunkBatch(p, "/root", map, { skipCache: true });
    expect(out.get("a.ts")?.get("c1")).toEqual({ y: 2 });
    expect(p.buildChunkSignals).toHaveBeenCalledWith("/root", map, { skipCache: true });
  });

  it("runFinalize delegates to finalizeSignals; empty map when absent", async () => {
    const present = await exec.runFinalize(fakeProvider(), "/root");
    expect(present.get("a.ts")).toEqual({ f: 4 });

    const absent = await exec.runFinalize(fakeProvider({ finalizeSignals: undefined }), "/root");
    expect(absent.size).toBe(0);
  });

  it("shutdown is a no-op resolved Promise", async () => {
    await expect(exec.shutdown()).resolves.toBeUndefined();
  });

  it("releaseCollection is a no-op on inline — does NOT call provider.onRelease", async () => {
    // Inline runs all collections through a SHARED provider instance (one
    // codegraph provider, many concurrent index_codebase calls). Calling
    // onRelease here would wipe state for every other in-flight run on the
    // same provider. The worker-pool executor handles per-collection
    // bounded memory via its own per-(collection,worker) cache; inline
    // intentionally leaves the long-lived provider state alone.
    const onRelease = vi.fn(async () => undefined);
    const provider = fakeProvider({ onRelease });
    await expect(exec.releaseCollection([provider], "code_xxx")).resolves.toBeUndefined();
    expect(onRelease).not.toHaveBeenCalled();
  });

  it("releaseCollection tolerates providers without an onRelease declaration", async () => {
    const provider = fakeProvider();
    await expect(exec.releaseCollection([provider], "code_xxx")).resolves.toBeUndefined();
  });
});
