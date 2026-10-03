import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmbeddingModelMismatchError } from "../../../../src/core/adapters/embeddings/errors.js";
import { OllamaUnavailableError } from "../../../../src/core/adapters/embeddings/ollama/errors.js";
import { EmbeddingModelGuard } from "../../../../src/core/adapters/qdrant/embedding-model-guard.js";
import { EMBEDDING_CANARY_TEXT, INDEXING_METADATA_ID } from "../../../../src/core/contracts/constants.js";

function createMockQdrant(markerPayload?: Record<string, unknown> | null) {
  return {
    getPoint: vi
      .fn()
      .mockResolvedValue(
        markerPayload === null
          ? null
          : { id: INDEXING_METADATA_ID, payload: markerPayload ?? { embeddingModel: "model-a" } },
      ),
    setPayload: vi.fn().mockResolvedValue(undefined),
    addPoints: vi.fn().mockResolvedValue(undefined),
    addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    collectionExists: vi.fn().mockResolvedValue(true),
  } as any;
}

describe("EmbeddingModelGuard", () => {
  let qdrant: ReturnType<typeof createMockQdrant>;

  beforeEach(() => {
    qdrant = createMockQdrant();
  });

  it("should pass when model matches", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await expect(guard.ensureMatch("col")).resolves.toBeUndefined();
  });

  it("should throw EmbeddingModelMismatchError on mismatch", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-b", 768);
    await expect(guard.ensureMatch("col")).rejects.toThrow(EmbeddingModelMismatchError);
    await expect(guard.ensureMatch("col")).rejects.toThrow(/model-a.*model-b/);
  });

  it("should cache result and not re-read Qdrant", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await guard.ensureMatch("col");
    await guard.ensureMatch("col");
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);
  });

  it("should backfill when marker exists but embeddingModel is missing", async () => {
    qdrant = createMockQdrant({ _type: "indexing_metadata", indexingComplete: true });
    const guard = new EmbeddingModelGuard(qdrant, "model-x", 768);
    await guard.ensureMatch("col");

    expect(qdrant.setPayload).toHaveBeenCalledWith(
      "col",
      { embeddingModel: "model-x" },
      { points: [INDEXING_METADATA_ID] },
    );
  });

  it("should create marker when no marker point exists", async () => {
    qdrant = createMockQdrant(null);
    const guard = new EmbeddingModelGuard(qdrant, "model-y", 384);
    await guard.ensureMatch("col");

    expect(qdrant.addPoints).toHaveBeenCalledWith("col", [
      expect.objectContaining({
        id: INDEXING_METADATA_ID,
        payload: expect.objectContaining({ embeddingModel: "model-y" }),
      }),
    ]);
  });

  it("should create hybrid marker when collection is hybrid", async () => {
    qdrant = createMockQdrant(null);
    qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    const guard = new EmbeddingModelGuard(qdrant, "model-z", 768);
    await guard.ensureMatch("col");

    expect(qdrant.addPointsWithSparse).toHaveBeenCalled();
    expect(qdrant.addPoints).not.toHaveBeenCalled();
  });

  it("should invalidate cache", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await guard.ensureMatch("col");
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);

    guard.invalidate("col");
    await guard.ensureMatch("col");
    expect(qdrant.getPoint).toHaveBeenCalledTimes(2);
  });

  it("should recordModel and use cache", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    guard.recordModel("col");
    await guard.ensureMatch("col");
    // No Qdrant read — cache hit from recordModel
    expect(qdrant.getPoint).not.toHaveBeenCalled();
  });

  it("should skip guard silently when Qdrant read fails", async () => {
    qdrant.getPoint.mockRejectedValue(new Error("qdrant down"));
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    // Should not throw
    await expect(guard.ensureMatch("col")).resolves.toBeUndefined();
  });

  it("should throw mismatch even when cached", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-b", 768);
    // First call reads and caches, throws mismatch
    await expect(guard.ensureMatch("col")).rejects.toThrow(EmbeddingModelMismatchError);
    // Second call uses cache, still throws
    await expect(guard.ensureMatch("col")).rejects.toThrow(EmbeddingModelMismatchError);
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);
  });

  it("should create hybrid marker with sparse vector for hybrid collection", async () => {
    qdrant = createMockQdrant(null);
    qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    const guard = new EmbeddingModelGuard(qdrant, "model-h", 768);
    await guard.ensureMatch("col");

    const call = qdrant.addPointsWithSparse.mock.calls[0];
    expect(call[1][0].sparseVector).toEqual({ indices: [], values: [] });
    expect(call[1][0].payload.embeddingModel).toBe("model-h");
  });

  it("should handle different collections independently", async () => {
    const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);
    await guard.ensureMatch("col-1");

    // col-2 has different model
    qdrant.getPoint.mockResolvedValueOnce({
      id: INDEXING_METADATA_ID,
      payload: { embeddingModel: "model-other" },
    });

    await expect(guard.ensureMatch("col-2")).rejects.toThrow(EmbeddingModelMismatchError);
    // col-1 still cached and ok
    await expect(guard.ensureMatch("col-1")).resolves.toBeUndefined();
  });

  describe("marker width follows the collection, not the configured guess", () => {
    // The guard is constructed at bootstrap with the model registry's guess. When
    // that guess is wrong the marker upsert is rejected, the guard caches null and
    // disables ITSELF — so two models can then be mixed in one collection. Its own
    // marker must therefore be sized from the collection it writes into.
    it("sizes the marker from the collection's vector size", async () => {
      qdrant = createMockQdrant(null);
      qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: false, vectorSize: 1024 });
      const guard = new EmbeddingModelGuard(qdrant, "model-y", 768);

      await guard.ensureMatch("col");

      const [, points] = qdrant.addPoints.mock.calls[0];
      expect(points[0].vector).toHaveLength(1024);
    });

    it("sizes the hybrid marker from the collection's vector size", async () => {
      qdrant = createMockQdrant(null);
      qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true, vectorSize: 1024 });
      const guard = new EmbeddingModelGuard(qdrant, "model-y", 768);

      await guard.ensureMatch("col");

      const [, points] = qdrant.addPointsWithSparse.mock.calls[0];
      expect(points[0].vector).toHaveLength(1024);
    });

    it("falls back to the configured dimensions when the collection reports none", async () => {
      qdrant = createMockQdrant(null);
      qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: false, vectorSize: 0 });
      const guard = new EmbeddingModelGuard(qdrant, "model-y", 384);

      await guard.ensureMatch("col");

      const [, points] = qdrant.addPoints.mock.calls[0];
      expect(points[0].vector).toHaveLength(384);
    });

    it("reports the collection it stopped guarding when marker access fails", async () => {
      // Self-disabling is deliberate — an unreachable Qdrant must not block search.
      // But it must never be inaudible: this is the moment model mixing becomes
      // possible, so it is reported regardless of debug mode.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      qdrant.getPoint.mockRejectedValue(new Error("qdrant down"));
      const guard = new EmbeddingModelGuard(qdrant, "model-a", 768);

      await expect(guard.ensureMatch("col")).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("col"), expect.anything());
      consoleError.mockRestore();
    });
  });
});

/**
 * Stateful marker fake: `createMockQdrant` above answers reads but forgets
 * writes, and the canary path is defined by what the marker holds AFTER the
 * guard wrote to it. Mirrors the calls `readOrCreateMarker` actually makes —
 * `getPoint` / `setPayload` / `addPoints` / `addPointsWithSparse` — over one
 * in-memory payload per collection, exposed through `marker(collection)`.
 */
function fakeQdrantWithMarker(markerPayload: Record<string, unknown> | null) {
  const markers = new Map<string, Record<string, unknown>>();
  // `null` = the collection has no marker point yet, so the guard takes its
  // create path; anything else seeds one on first read.
  const markerFor = (collection: string): Record<string, unknown> | undefined => {
    let payload = markers.get(collection);
    if (!payload && markerPayload !== null) {
      payload = { _type: "indexing_metadata", indexingComplete: true, ...markerPayload };
      markers.set(collection, payload);
    }
    return payload;
  };

  return {
    marker: (collection: string) => markerFor(collection) ?? {},
    getPoint: vi.fn(async (collection: string) => {
      const payload = markerFor(collection);
      return payload ? { id: INDEXING_METADATA_ID, payload } : null;
    }),
    setPayload: vi.fn(async (collection: string, fields: Record<string, unknown>) => {
      const payload = markerFor(collection);
      if (payload) Object.assign(payload, fields);
    }),
    addPoints: vi.fn(async (collection: string, points: { payload: Record<string, unknown> }[]) => {
      markers.set(collection, { ...points[0].payload });
    }),
    addPointsWithSparse: vi.fn(async (collection: string, points: { payload: Record<string, unknown> }[]) => {
      markers.set(collection, { ...points[0].payload });
    }),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 4 }),
    collectionExists: vi.fn().mockResolvedValue(true),
  } as any;
}

function providerReturning(vector: number[]) {
  return { embed: async () => ({ embedding: vector }) } as never;
}
const V = [1, 0, 0, 0];
const ORTHOGONAL = [0, 1, 0, 0];

describe("EmbeddingModelGuard canary", () => {
  it("writes the canary into a marker that has none", async () => {
    const qdrant = fakeQdrantWithMarker({ embeddingModel: "m" });
    await new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(V)).ensureMatch("c");
    expect(qdrant.marker("c").canary).toEqual({ text: EMBEDDING_CANARY_TEXT, vector: V });
  });

  it("passes when the same name embeds the canary to the same vector", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    await expect(
      new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(V)).ensureMatch("c"),
    ).resolves.toBeUndefined();
  });

  it("rejects the same name when the weights changed", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    await expect(
      new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(ORTHOGONAL)).ensureMatch("c"),
    ).rejects.toThrow(/same name, different weights: canary cosine 0\.0000/);
  });

  it("without a provider behaves as before", async () => {
    const qdrant = fakeQdrantWithMarker({ embeddingModel: "m" });
    await new EmbeddingModelGuard(qdrant, "m", 4).ensureMatch("c");
    expect(qdrant.marker("c").canary).toBeUndefined();
  });

  it("rejects a canary stored at a different width", async () => {
    // A width change is a model change, and cosine over ragged vectors is NaN —
    // which compares false against the threshold and would pass silently.
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: [1, 0, 0] },
    });
    await expect(new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(V)).ensureMatch("c")).rejects.toThrow(
      /canary cosine 0\.0000/,
    );
  });

  it("replaces a canary written for a different text instead of reporting drift", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: "a canary from an older release", vector: ORTHOGONAL },
    });
    await new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(V)).ensureMatch("c");
    expect(qdrant.marker("c").canary).toEqual({ text: EMBEDDING_CANARY_TEXT, vector: V });
  });

  it("keeps rejecting from cache without re-embedding the canary", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    const embed = vi.fn(async () => ({ embedding: ORTHOGONAL }));
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

    await expect(guard.ensureMatch("c")).rejects.toThrow(EmbeddingModelMismatchError);
    await expect(guard.ensureMatch("c")).rejects.toThrow(EmbeddingModelMismatchError);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("skips the canary when the provider cannot embed", async () => {
    // Provider down must not block indexing — the guard degrades to the name
    // comparison and says so once, exactly as a failed marker read does.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const qdrant = fakeQdrantWithMarker({ embeddingModel: "m" });
    const provider = {
      embed: async () => {
        throw new Error("ollama down");
      },
    } as never;

    await expect(new EmbeddingModelGuard(qdrant, "m", 4, provider).ensureMatch("c")).resolves.toBeUndefined();

    expect(qdrant.marker("c").canary).toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Canary check skipped"), expect.anything());
    consoleError.mockRestore();
  });

  it("folds the canary into a marker it creates, without a second write", async () => {
    const qdrant = fakeQdrantWithMarker(null);
    await new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(V)).ensureMatch("c");

    const [, points] = qdrant.addPoints.mock.calls[0];
    expect(points[0].payload.canary).toEqual({ text: EMBEDDING_CANARY_TEXT, vector: V });
    expect(qdrant.setPayload).not.toHaveBeenCalled();
  });

  it("tells the canary case to rebuild the index, not to edit EMBEDDING_MODEL", async () => {
    // The generic hint's first option is "point EMBEDDING_MODEL at <expected>",
    // and for canary drift expected IS what the config already says — following
    // it changes nothing.
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(ORTHOGONAL));

    const error = await guard.ensureMatch("c").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EmbeddingModelMismatchError);
    const { hint } = error as EmbeddingModelMismatchError;
    expect(hint).not.toContain("EMBEDDING_MODEL in config");
    expect(hint).toContain("--force");
  });

  it("re-checks a cached mismatch after invalidateAll (endpoint failover)", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    const embed = vi.fn(async () => ({ embedding: ORTHOGONAL }));
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

    await expect(guard.ensureMatch("c")).rejects.toThrow(EmbeddingModelMismatchError);
    guard.invalidateAll();
    await expect(guard.ensureMatch("c")).rejects.toThrow(EmbeddingModelMismatchError);

    expect(embed).toHaveBeenCalledTimes(2);
  });

  it("embeds once for concurrent first checks of the same collection", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    const embed = vi.fn(async () => ({ embedding: V }));
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

    await Promise.all([guard.ensureMatch("c"), guard.ensureMatch("c"), guard.ensureMatch("c")]);

    expect(embed).toHaveBeenCalledTimes(1);
    expect(qdrant.getPoint).toHaveBeenCalledTimes(1);
  });

  it("discards a verdict measured before an invalidation landed", async () => {
    // The failover hook can fire while a check is in flight. That check
    // measured the endpoint we just left, so its verdict must not be installed
    // behind the invalidation that was meant to clear exactly this.
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    let release: ((result: { embedding: number[] }) => void) | undefined;
    const embed = vi.fn(
      async () =>
        new Promise<{ embedding: number[] }>((resolve) => {
          release = resolve;
        }),
    );
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

    const inFlight = guard.ensureMatch("c");
    await vi.waitFor(() => {
      expect(embed).toHaveBeenCalledTimes(1);
    });
    guard.invalidateAll();
    release?.({ embedding: ORTHOGONAL });
    await expect(inFlight).resolves.toBeUndefined();

    const second = guard.ensureMatch("c");
    await vi.waitFor(() => {
      expect(embed).toHaveBeenCalledTimes(2);
    });
    release?.({ embedding: V });
    await expect(second).resolves.toBeUndefined();
  });

  it("retries the canary when the create path could not embed it", async () => {
    // A marker created while the provider was down has no canary. Caching a
    // clean verdict there would leave the collection unguarded for the whole
    // process; the next check has to try again.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const qdrant = fakeQdrantWithMarker(null);
    const embed = vi
      .fn<() => Promise<{ embedding: number[] }>>()
      .mockRejectedValueOnce(new Error("ollama down"))
      .mockResolvedValue({ embedding: V });
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

    await guard.ensureMatch("c");
    const [, created] = qdrant.addPoints.mock.calls[0];
    expect(created[0].payload.canary).toBeUndefined();

    await guard.ensureMatch("c");

    expect(embed).toHaveBeenCalledTimes(2);
    expect(qdrant.marker("c").canary).toEqual({ text: EMBEDDING_CANARY_TEXT, vector: V });
    consoleError.mockRestore();
  });

  /**
   * A caller that compares no freshly embedded vector against the index
   * (`rank_chunks`, `find_symbol`) has nothing the canary could protect, and
   * embedding it made every such cold call wait out the provider's endpoint
   * failover (~6.4 s on an unreachable primary — bd tea-rags-mcp-xi2r9, B3).
   */
  describe("a caller that embeds nothing (nameOnly)", () => {
    it("checks the name without embedding the canary", async () => {
      const qdrant = fakeQdrantWithMarker({ embeddingModel: "m", canary: { text: EMBEDDING_CANARY_TEXT, vector: V } });
      const embed = vi.fn(async () => ({ embedding: ORTHOGONAL }));
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

      await expect(guard.ensureMatch("c", { nameOnly: true })).resolves.toBeUndefined();
      expect(embed).not.toHaveBeenCalled();
    });

    it("still rejects a marker naming another model", async () => {
      const qdrant = fakeQdrantWithMarker({ embeddingModel: "other" });
      const embed = vi.fn(async () => ({ embedding: V }));
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

      await expect(guard.ensureMatch("c", { nameOnly: true })).rejects.toThrow(EmbeddingModelMismatchError);
      expect(embed).not.toHaveBeenCalled();
    });

    it("leaves the canary to the first caller that embeds", async () => {
      const qdrant = fakeQdrantWithMarker({ embeddingModel: "m", canary: { text: EMBEDDING_CANARY_TEXT, vector: V } });
      const embed = vi.fn(async () => ({ embedding: ORTHOGONAL }));
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

      await guard.ensureMatch("c", { nameOnly: true });
      await expect(guard.ensureMatch("c")).rejects.toThrow(/same name, different weights/);
      expect(embed).toHaveBeenCalledOnce();
    });

    it("answers from a cached canary mismatch without a Qdrant read", async () => {
      const qdrant = fakeQdrantWithMarker({ embeddingModel: "m", canary: { text: EMBEDDING_CANARY_TEXT, vector: V } });
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, providerReturning(ORTHOGONAL));
      await expect(guard.ensureMatch("c")).rejects.toThrow(EmbeddingModelMismatchError);
      const reads = qdrant.getPoint.mock.calls.length;

      await expect(guard.ensureMatch("c", { nameOnly: true })).rejects.toThrow(/same name, different weights/);
      expect(qdrant.getPoint.mock.calls.length).toBe(reads);
    });

    it("creates no marker for a collection that has none", async () => {
      const qdrant = fakeQdrantWithMarker(null);
      const embed = vi.fn(async () => ({ embedding: V }));
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

      await expect(guard.ensureMatch("c", { nameOnly: true })).resolves.toBeUndefined();
      expect(qdrant.addPoints).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    });
  });

  it("resolves the provider's endpoint before a check starts, so its failover cannot discard that check", async () => {
    const qdrant = fakeQdrantWithMarker({ embeddingModel: "m", canary: { text: EMBEDDING_CANARY_TEXT, vector: V } });
    const slot: { guard?: EmbeddingModelGuard } = {};
    // The failover hook fires during endpoint resolution, as the factory wires it.
    const resolveEndpoint = vi.fn(async () => {
      slot.guard?.invalidateAll();
    });
    const embed = vi.fn(async () => ({ embedding: ORTHOGONAL }));
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed, resolveEndpoint } as never);
    slot.guard = guard;

    await expect(guard.ensureMatch("c")).rejects.toThrow(/same name, different weights/);
    expect(resolveEndpoint).toHaveBeenCalledOnce();
  });

  describe("provider down after a spent recovery wait (bd tea-rags-mcp-umatc)", () => {
    // The provider already waited EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS
    // out on the canary embed. A caller that embeds next would wait it out
    // again, so the outage reaches that caller instead of being swallowed.
    const waitedOut = () => new OllamaUnavailableError("http://127.0.0.1:59999", undefined, undefined, 10_000);

    it("reaches a caller that embeds next, on the read path", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const qdrant = fakeQdrantWithMarker({
        embeddingModel: "m",
        canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
      });
      const outage = waitedOut();
      const embed = vi.fn().mockRejectedValue(outage);
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

      await expect(guard.ensureMatch("c", { failOnProviderOutage: true })).rejects.toBe(outage);
      expect(embed).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    });

    it("reaches a caller that embeds next, on the create path, and the marker is still created", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const qdrant = fakeQdrantWithMarker(null);
      const outage = waitedOut();
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed: vi.fn().mockRejectedValue(outage) } as never);

      await expect(guard.ensureMatch("c", { failOnProviderOutage: true })).rejects.toBe(outage);
      expect(qdrant.marker("c")).toMatchObject({ embeddingModel: "m" });
      expect(qdrant.marker("c").canary).toBeUndefined();
      consoleError.mockRestore();
    });

    it("never blocks a caller that does not embed", async () => {
      // find_symbol / rank_chunks read the index without a query embed; a down
      // provider must not take them down with it.
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const qdrant = fakeQdrantWithMarker({
        embeddingModel: "m",
        canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
      });
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, {
        embed: vi.fn().mockRejectedValue(waitedOut()),
      } as never);

      await expect(guard.ensureMatch("c")).resolves.toBeUndefined();
      consoleError.mockRestore();
    });

    it("an embed failure without a spent wait never blocks, even a caller that embeds next", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const qdrant = fakeQdrantWithMarker({
        embeddingModel: "m",
        canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
      });
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, {
        embed: vi.fn().mockRejectedValue(new OllamaUnavailableError("http://127.0.0.1:59999")),
      } as never);

      await expect(guard.ensureMatch("c", { failOnProviderOutage: true })).resolves.toBeUndefined();
      consoleError.mockRestore();
    });

    it("reaches every caller that embeds next and joined the same in-flight check", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const qdrant = fakeQdrantWithMarker({
        embeddingModel: "m",
        canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
      });
      const outage = waitedOut();
      const embed = vi.fn().mockRejectedValue(outage);
      const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

      const reader = guard.ensureMatch("c");
      const embedder = guard.ensureMatch("c", { failOnProviderOutage: true });

      await expect(reader).resolves.toBeUndefined();
      await expect(embedder).rejects.toBe(outage);
      expect(embed).toHaveBeenCalledTimes(1);
      consoleError.mockRestore();
    });
  });

  it("invalidateAll drops every collection, not just the last one", async () => {
    const qdrant = fakeQdrantWithMarker({
      embeddingModel: "m",
      canary: { text: EMBEDDING_CANARY_TEXT, vector: V },
    });
    const embed = vi.fn(async () => ({ embedding: V }));
    const guard = new EmbeddingModelGuard(qdrant, "m", 4, { embed } as never);

    await guard.ensureMatch("c1");
    await guard.ensureMatch("c2");
    expect(embed).toHaveBeenCalledTimes(2);

    guard.invalidateAll();
    await guard.ensureMatch("c1");
    await guard.ensureMatch("c2");
    expect(embed).toHaveBeenCalledTimes(4);
  });
});
