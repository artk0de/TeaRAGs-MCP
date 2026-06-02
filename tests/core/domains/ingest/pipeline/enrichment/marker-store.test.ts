import { beforeEach, describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

describe("EnrichmentMarkerStore (terminal-only + runId, nested storage)", () => {
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

  describe("markRunStart", () => {
    it("writes only the _run pointer (runId, timestamps, providers) — no per-level status", async () => {
      await store.markRunStart(COLL, ["git", "codegraph.symbols"], "run-abc", "2026-06-01T10:00:00Z");
      const e = (await store.read(COLL))!;
      expect((e._run as any).runId).toBe("run-abc");
      expect((e._run as any).startedAt).toBe("2026-06-01T10:00:00Z");
      expect((e._run as any).lastProgressAt).toBe("2026-06-01T10:00:00Z");
      expect((e._run as any).providers).toEqual(["git", "codegraph.symbols"]);
      // No provider markers exist yet — absence == not finished.
      expect(e.git).toBeUndefined();
      expect(e.codegraph).toBeUndefined();
    });
  });

  describe("heartbeat", () => {
    it("advances _run.lastProgressAt while preserving runId, startedAt, providers", async () => {
      await store.markRunStart(COLL, ["git"], "run-1", "2026-06-01T10:00:00Z");
      await store.heartbeat(COLL, ["git"], "run-1", "2026-06-01T10:00:00Z", "2026-06-01T10:00:30Z");
      const run = (await store.read(COLL))!._run as any;
      expect(run.runId).toBe("run-1");
      expect(run.startedAt).toBe("2026-06-01T10:00:00Z");
      expect(run.lastProgressAt).toBe("2026-06-01T10:00:30Z");
      expect(run.providers).toEqual(["git"]);
    });
  });

  describe("terminal writers carry runId via disjoint nested keys", () => {
    it("markFileFinal writes enrichment.git.file with runId, preserving a sibling chunk write", async () => {
      await store.markChunkFinal(COLL, "git", {
        runId: "r1",
        status: "completed",
        durationMs: 5,
        unenrichedChunks: 0,
      });
      await store.markFileFinal(COLL, "git", {
        runId: "r1",
        status: "completed",
        durationMs: 10,
        unenrichedChunks: 0,
        matchedFiles: 9,
        missedFiles: 1,
      });
      const git = (await store.read(COLL))!.git as any;
      expect(git.file.runId).toBe("r1");
      expect(git.file.status).toBe("completed");
      expect(git.file.matchedFiles).toBe(9);
      expect(typeof git.file.completedAt).toBe("string");
      // sibling chunk write survived (no read-modify-write clobber)
      expect(git.chunk.status).toBe("completed");
      expect(git.chunk.runId).toBe("r1");
    });

    it("stores a dotted provider key NESTED (codegraph.symbols → enrichment.codegraph.symbols)", async () => {
      await store.markFileFinal(COLL, "codegraph.symbols", {
        runId: "r1",
        status: "degraded",
        durationMs: 1,
        unenrichedChunks: 4,
        matchedFiles: 2,
        missedFiles: 1,
      });
      const e = (await store.read(COLL))! as any;
      // Nested under codegraph → symbols → file (matches the applier convention),
      // NOT a literal "codegraph.symbols" property.
      expect(e.codegraph.symbols.file.status).toBe("degraded");
      expect(e.codegraph.symbols.file.runId).toBe("r1");
      expect(e["codegraph.symbols"]).toBeUndefined();
    });

    it("concurrent terminal writes to all four kinds all survive (race-free)", async () => {
      await Promise.all([
        store.markFileFinal(COLL, "git", {
          runId: "r",
          status: "completed",
          durationMs: 1,
          unenrichedChunks: 0,
          matchedFiles: 1,
          missedFiles: 0,
        }),
        store.markChunkFinal(COLL, "git", { runId: "r", status: "completed", durationMs: 1, unenrichedChunks: 0 }),
        store.markFileFinal(COLL, "codegraph.symbols", {
          runId: "r",
          status: "completed",
          durationMs: 1,
          unenrichedChunks: 0,
          matchedFiles: 1,
          missedFiles: 0,
        }),
        store.markChunkFinal(COLL, "codegraph.symbols", {
          runId: "r",
          status: "completed",
          durationMs: 1,
          unenrichedChunks: 0,
        }),
      ]);
      const e = (await store.read(COLL))! as any;
      expect(e.git.file.status).toBe("completed");
      expect(e.git.chunk.status).toBe("completed");
      expect(e.codegraph.symbols.file.status).toBe("completed");
      expect(e.codegraph.symbols.chunk.status).toBe("completed");
    });

    it("issues a key-scoped batchSetPayload with wait:true (git → enrichment.git.file)", async () => {
      await store.markFileFinal(COLL, "git", {
        runId: "r1",
        status: "completed",
        durationMs: 10,
        unenrichedChunks: 0,
        matchedFiles: 1,
        missedFiles: 0,
      });
      const call = (qdrant as any).batchSetPayloadCalls.at(-1);
      expect(call.operations[0].key).toBe("enrichment.git.file");
    });
  });

  describe("markPrefetchFailed", () => {
    it("writes both levels failed with runId + errorMessage (nested for codegraph)", async () => {
      await store.markPrefetchFailed(
        COLL,
        "codegraph.symbols",
        "r1",
        "2026-06-01T10:00:00Z",
        3500,
        "Codegraph spill write failed at /tmp/cg/.spill/run.ndjson",
      );
      const cg = (await store.read(COLL))!.codegraph as any;
      expect(cg.symbols.file.status).toBe("failed");
      expect(cg.symbols.file.runId).toBe("r1");
      expect(cg.symbols.file.durationMs).toBe(3500);
      expect(cg.symbols.file.errorMessage).toBe("Codegraph spill write failed at /tmp/cg/.spill/run.ndjson");
      expect(cg.symbols.chunk.status).toBe("failed");
      expect(cg.symbols.chunk.errorMessage).toBe("Codegraph spill write failed at /tmp/cg/.spill/run.ndjson");
    });
  });

  describe("markRecoveryResult", () => {
    it("stamps the snapshotted runId on both levels", async () => {
      await store.markRecoveryResult(COLL, "git", {
        runId: "rec-9",
        fileStatus: "completed",
        fileUnenriched: 0,
        chunkStatus: "degraded",
        chunkUnenriched: 7,
      });
      const git = (await store.read(COLL))!.git as any;
      expect(git.file.runId).toBe("rec-9");
      expect(git.file.status).toBe("completed");
      expect(git.chunk.runId).toBe("rec-9");
      expect(git.chunk.status).toBe("degraded");
      expect(git.chunk.unenrichedChunks).toBe(7);
    });
  });

  describe("read / getRunId", () => {
    it("read returns null when marker missing", async () => {
      expect(await store.read(COLL)).toBeNull();
    });
    it("getRunId navigates nested for a dotted provider key", async () => {
      await store.markFileFinal(COLL, "codegraph.symbols", {
        runId: "run-zz",
        status: "completed",
        durationMs: 1,
        unenrichedChunks: 0,
        matchedFiles: 1,
        missedFiles: 0,
      });
      expect(await store.getRunId(COLL, "codegraph.symbols")).toBe("run-zz");
      expect(await store.getRunId(COLL, "git")).toBeUndefined();
      expect(await store.getRunId(COLL, "absent")).toBeUndefined();
    });
  });
});
