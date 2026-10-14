/**
 * UNENRICHED_SAMPLE debug line (bd tea-rags-mcp-2d5o1): when a marker settles
 * with unenriched points, one DEBUG-only line names a bounded sample of them
 * plus the collection's reported vs exact point count, so the next occurrence
 * can be attributed. Read-only; silent at count 0 or with DEBUG off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";
import { pipelineLog } from "../../../../../../src/core/domains/ingest/pipeline/infra/debug-log/debug-logger.js";
import { setDebug } from "../../../../../../src/core/primitives/diagnostics/debug-flag.js";

function makePoints(n: number): { id: string; payload: Record<string, unknown> }[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    payload: {
      relativePath: `src/f${i}.ts`,
      chunkType: "function",
      language: "typescript",
      git: { chunk: { enrichedAt: "2026-01-01T00:00:00Z" } },
    },
  }));
}

describe("EnrichmentRecovery#logUnenrichedSample", () => {
  const provider = { key: "git" } as never;
  let qdrant: {
    scrollFiltered: ReturnType<typeof vi.fn>;
    countPoints: ReturnType<typeof vi.fn>;
    getCollectionInfo: ReturnType<typeof vi.fn>;
  };
  let recovery: EnrichmentRecovery;
  let phases: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    qdrant = {
      scrollFiltered: vi.fn().mockResolvedValue(makePoints(10)),
      countPoints: vi.fn().mockResolvedValue(100),
      getCollectionInfo: vi.fn().mockResolvedValue({ pointsCount: 103 }),
    };
    recovery = new EnrichmentRecovery(qdrant as never, {} as never);
    phases = vi.spyOn(pipelineLog, "enrichmentPhase").mockImplementation(() => undefined);
    setDebug(true);
  });

  afterEach(() => {
    setDebug(false);
    vi.restoreAllMocks();
  });

  it("emits one UNENRICHED_SAMPLE line with <=10 samples and the count comparison", async () => {
    await recovery.logUnenrichedSample("coll", provider, "chunk", 124);

    expect(qdrant.scrollFiltered).toHaveBeenCalledWith("coll", expect.anything(), 10, 10, expect.any(Array));
    const lines = phases.mock.calls.filter(([phase]: unknown[]) => phase === "UNENRICHED_SAMPLE");
    expect(lines).toHaveLength(1);
    const data = lines[0][1] as Record<string, unknown>;
    expect(data).toMatchObject({ provider: "git", level: "chunk", count: 124, pointsCount: 103, exactCount: 100 });
    const samples = data.samples as Record<string, unknown>[];
    expect(samples).toHaveLength(10);
    expect(samples[0]).toEqual({
      id: "p0",
      relativePath: "src/f0.ts",
      chunkType: "function",
      language: "typescript",
      enrichedAt: "2026-01-01T00:00:00Z",
      skippedAs: undefined,
    });
  });

  it("caps samples at 10 even when the scroll over-returns", async () => {
    qdrant.scrollFiltered.mockResolvedValue(makePoints(25));
    await recovery.logUnenrichedSample("coll", provider, "file", 25);
    const data = phases.mock.calls[0][1] as { samples: unknown[] };
    expect(data.samples).toHaveLength(10);
  });

  it("is silent and reads nothing when count is 0", async () => {
    await recovery.logUnenrichedSample("coll", provider, "chunk", 0);
    expect(phases).not.toHaveBeenCalled();
    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
    expect(qdrant.countPoints).not.toHaveBeenCalled();
  });

  it("is silent and reads nothing when DEBUG is off", async () => {
    setDebug(false);
    await recovery.logUnenrichedSample("coll", provider, "chunk", 15);
    expect(phases).not.toHaveBeenCalled();
    expect(qdrant.scrollFiltered).not.toHaveBeenCalled();
  });

  it("degrades a failing read to a missing field instead of throwing", async () => {
    qdrant.countPoints.mockRejectedValue(new Error("down"));
    qdrant.getCollectionInfo.mockRejectedValue(new Error("down"));
    await expect(recovery.logUnenrichedSample("coll", provider, "chunk", 3)).resolves.toBeUndefined();
    expect(phases.mock.calls[0][1]).toMatchObject({ exactCount: null, pointsCount: null });
  });
});

describe("EnrichmentCoordinator#countSettledUnenriched sampling", () => {
  const settle = async (recovery: unknown, count: number) => {
    const fake = { recovery: { countUnenriched: vi.fn().mockResolvedValue(count), ...(recovery as object) } };
    return (
      EnrichmentCoordinator.prototype as unknown as {
        countSettledUnenriched: (this: unknown, ...a: unknown[]) => Promise<number>;
      }
    ).countSettledUnenriched.call(fake, "coll", { key: "git" }, "file", ["ts"]);
  };

  afterEach(() => {
    setDebug(false);
  });

  it("never fails the completion when the sampler throws", async () => {
    const logUnenrichedSample = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(settle({ logUnenrichedSample }, 15)).resolves.toBe(15);
  });

  it("samples a non-zero settled count and returns the count unchanged", async () => {
    setDebug(true);
    const logUnenrichedSample = vi.fn().mockResolvedValue(undefined);
    await expect(settle({ logUnenrichedSample }, 15)).resolves.toBe(15);
    expect(logUnenrichedSample).toHaveBeenCalledWith("coll", { key: "git" }, "file", 15, ["ts"]);
  });

  it("does not sample a zero count", async () => {
    setDebug(true);
    const logUnenrichedSample = vi.fn();
    await expect(settle({ logUnenrichedSample }, 0)).resolves.toBe(0);
    expect(logUnenrichedSample).not.toHaveBeenCalled();
  });
});
