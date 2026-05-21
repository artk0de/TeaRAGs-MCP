import { beforeEach, describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

describe("EnrichmentMarkerStore", () => {
  let qdrant: MockQdrantManager;
  let store: EnrichmentMarkerStore;
  const COLL = "test_coll";

  beforeEach(async () => {
    qdrant = new MockQdrantManager();
    await qdrant.createCollection(COLL, 384);
    // Real Qdrant set_payload requires the point to exist; production seeds
    // INDEXING_METADATA_ID via storeIndexingMarker before enrichment starts.
    await qdrant.addPoints(COLL, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
    store = new EnrichmentMarkerStore(qdrant as any);
  });

  describe("markStart", () => {
    it("writes initial marker with runId, file=in_progress, chunk=pending for each provider", async () => {
      await store.markStart(COLL, ["git", "static"], "run-abc", "2026-05-07T10:00:00Z");

      const point = await qdrant.getPoint(COLL, INDEXING_METADATA_ID);
      const enrichment = point?.payload?.enrichment as Record<string, any>;
      expect(enrichment.git.runId).toBe("run-abc");
      expect(enrichment.git.file.status).toBe("in_progress");
      expect(enrichment.git.file.startedAt).toBe("2026-05-07T10:00:00Z");
      expect(enrichment.git.chunk.status).toBe("pending");
      expect(enrichment.static.runId).toBe("run-abc");
      expect(enrichment.static.file.status).toBe("in_progress");
    });
  });

  describe("markPrefetchFailed", () => {
    it("writes file=failed and chunk=failed with durationMs", async () => {
      await store.markStart(COLL, ["git"], "r1", "2026-05-07T10:00:00Z");
      await store.markPrefetchFailed(COLL, "git", "r1", "2026-05-07T10:00:00Z", 4200);
      const m = (await store.read(COLL))!.git as any;
      expect(m.file.status).toBe("failed");
      expect(m.file.durationMs).toBe(4200);
      expect(m.chunk.status).toBe("failed");
    });

    it("propagates errorMessage onto both file and chunk markers (slice 2 — surfaces concrete failure in get_index_status)", async () => {
      await store.markStart(COLL, ["codegraph.symbols"], "r1", "2026-05-21T10:00:00Z");
      await store.markPrefetchFailed(
        COLL,
        "codegraph.symbols",
        "r1",
        "2026-05-21T10:00:00Z",
        3500,
        "Codegraph spill write failed at /tmp/cg/.spill/run.ndjson",
      );
      const m = (await store.read(COLL))!["codegraph.symbols"] as any;
      expect(m.file.status).toBe("failed");
      expect(m.file.errorMessage).toBe("Codegraph spill write failed at /tmp/cg/.spill/run.ndjson");
      expect(m.chunk.errorMessage).toBe("Codegraph spill write failed at /tmp/cg/.spill/run.ndjson");
    });
  });

  describe("markRecoveryResult", () => {
    it("writes both file and chunk statuses together", async () => {
      await store.markRecoveryResult(COLL, "git", {
        fileStatus: "completed",
        fileUnenriched: 0,
        chunkStatus: "degraded",
        chunkUnenriched: 7,
      });
      const m = (await store.read(COLL))!.git as any;
      expect(m.file.status).toBe("completed");
      expect(m.chunk.status).toBe("degraded");
      expect(m.chunk.unenrichedChunks).toBe(7);
    });
  });

  describe("markFileFinal", () => {
    it("writes completedAt and counters", async () => {
      await store.markFileFinal(COLL, "git", {
        status: "completed",
        durationMs: 1200,
        unenrichedChunks: 0,
        matchedFiles: 42,
        missedFiles: 3,
      });
      const m = (await store.read(COLL))!.git as any;
      expect(m.file.status).toBe("completed");
      expect(m.file.matchedFiles).toBe(42);
      expect(m.file.missedFiles).toBe(3);
      expect(typeof m.file.completedAt).toBe("string");
    });
  });

  describe("markChunkFinal", () => {
    it("writes degraded status with unenrichedChunks", async () => {
      await store.markChunkFinal(COLL, "git", {
        status: "degraded",
        durationMs: 8500,
        unenrichedChunks: 12,
      });
      const m = (await store.read(COLL))!.git as any;
      expect(m.chunk.status).toBe("degraded");
      expect(m.chunk.unenrichedChunks).toBe(12);
      expect(m.chunk.durationMs).toBe(8500);
    });
  });

  // Regression for tea-rags self-test bug 2026-05-21: marker writes
  // without `wait: true` race against subsequent reads. Sequential
  // markFileFinal/markChunkFinal calls do read-modify-write; without
  // wait, the next read may not see the prior write yet, and the new
  // write clobbers the prior status back to its previous snapshot.
  // Symptom: only the last write in a chain survives; all earlier
  // statuses revert. Fixing this end-to-end requires `wait: true` on
  // every setPayload call inside marker-store.write().
  describe("setPayload wait flag", () => {
    it("passes wait:true so qdrant reads see the new payload before the next write reads", async () => {
      let observedWait: boolean | undefined;
      const wrappedQdrant = {
        ...qdrant,
        getPoint: async (coll: string, id: string | number) => qdrant.getPoint(coll, id),
        setPayload: async (
          coll: string,
          payload: Record<string, unknown>,
          options: { points?: (string | number)[]; wait?: boolean },
        ) => {
          observedWait = options.wait;
          return qdrant.setPayload(coll, payload, options as any);
        },
      } as unknown as typeof qdrant;
      const isolatedStore = new EnrichmentMarkerStore(wrappedQdrant as any);
      await isolatedStore.markStart(COLL, ["git"], "r-wait", "2026-05-07T10:00:00Z");
      expect(observedWait).toBe(true);
    });
  });

  describe("read / getRunId", () => {
    it("read returns null when marker missing", async () => {
      expect(await store.read(COLL)).toBeNull();
    });
    it("getRunId returns the runId stored at markStart", async () => {
      await store.markStart(COLL, ["git"], "run-zz", "2026-05-07T10:00:00Z");
      expect(await store.getRunId(COLL, "git")).toBe("run-zz");
      expect(await store.getRunId(COLL, "absent")).toBeUndefined();
    });
  });

  describe("deep-merge across calls", () => {
    it("preserves chunk fields when only file is updated", async () => {
      await store.markStart(COLL, ["git"], "r1", "2026-05-07T10:00:00Z");
      await store.markFileFinal(COLL, "git", {
        status: "completed",
        durationMs: 100,
        unenrichedChunks: 0,
        matchedFiles: 1,
        missedFiles: 0,
      });
      const m = (await store.read(COLL))!.git as any;
      expect(m.file.status).toBe("completed");
      expect(m.chunk.status).toBe("pending"); // <-- preserved
      expect(m.runId).toBe("r1"); // <-- preserved
    });
  });
});
