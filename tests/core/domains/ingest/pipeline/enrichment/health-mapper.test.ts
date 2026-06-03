import { afterEach, describe, expect, it, vi } from "vitest";

import { mapMarkerToHealth } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/health-mapper.js";
import type {
  EnrichmentMarkerMap,
  RunMarker,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

const RUN = "run-1";

function run(over: Partial<RunMarker> = {}): RunMarker {
  const now = new Date().toISOString();
  return { runId: RUN, startedAt: now, lastProgressAt: now, providers: ["git"], ...over };
}

describe("mapMarkerToHealth (terminal-only + runId staleness)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders healthy when marker.runId matches _run.runId and status completed", () => {
    const map = {
      _run: run(),
      git: {
        file: { runId: RUN, status: "completed", unenrichedChunks: 0 },
        chunk: { runId: RUN, status: "completed", unenrichedChunks: 0 },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("healthy");
    expect(r.git.chunk.status).toBe("healthy");
    expect(r.git.file.unenrichedChunks).toBeUndefined();
  });

  it("NO false healthy on hang: file terminal present, chunk marker ABSENT → chunk in_progress", () => {
    const map = {
      _run: run(),
      git: { file: { runId: RUN, status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("healthy");
    expect(r.git.chunk.status).toBe("in_progress"); // <-- was the pending→healthy bug
  });

  it("stale runId: marker from a previous run while a new run is active → in_progress", () => {
    const map = {
      _run: run({ runId: "run-2" }),
      git: {
        file: { runId: "run-1", status: "completed", unenrichedChunks: 0 },
        chunk: { runId: "run-1", status: "completed", unenrichedChunks: 0 },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.status).toBe("in_progress");
    expect(r.git.chunk.status).toBe("in_progress");
  });

  it("navigates a dotted provider key nested (codegraph.symbols → enrichment.codegraph.symbols)", () => {
    const map = {
      _run: run({ providers: ["codegraph.symbols"] }),
      codegraph: {
        symbols: {
          file: { runId: RUN, status: "completed", unenrichedChunks: 0 },
          chunk: { runId: RUN, status: "degraded", unenrichedChunks: 12 },
        },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r["codegraph.symbols"].file.status).toBe("healthy");
    expect(r["codegraph.symbols"].chunk).toMatchObject({ status: "degraded", unenrichedChunks: 12 });
  });

  it("recent heartbeat (<2min) + non-terminal level marker (absent/stale runId) → in_progress with healthy message, NOT stalled", () => {
    // Contract: a run whose _run.lastProgressAt was updated < 2 min ago
    // (throttled heartbeat from onChunksStored) must NOT read as "stalled".
    // This documents the fix for the false-stalled bug on long-running enrichments.
    const recent = new Date(Date.now() - 30 * 1000).toISOString(); // 30s ago
    const map = {
      _run: run({ lastProgressAt: recent }),
      // chunk marker absent (non-terminal) → derived from _run timestamps
      git: { file: { runId: "other-run", status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.chunk.status).toBe("in_progress");
    expect(r.git.chunk.message).toBe("Enrichment in progress...");
    expect(r.git.chunk.message).not.toMatch(/stalled/i);
    // Inverse (git.file has stale runId → also derives in_progress, not healthy)
    expect(r.git.file.status).toBe("in_progress");
    expect(r.git.file.message).toBe("Enrichment in progress...");
    expect(r.git.file.message).not.toMatch(/stalled/i);
  });

  it("stalled: no progress in >2min → in_progress with stalled message", () => {
    const stale = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const map = {
      _run: run({ lastProgressAt: stale }),
      git: { file: { runId: RUN, status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.chunk.status).toBe("in_progress");
    expect(r.git.chunk.message).toMatch(/stalled/i);
  });

  it("crashed: no progress in >1h → failed", () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const map = {
      _run: run({ startedAt: old, lastProgressAt: old }),
      git: { file: { runId: RUN, status: "completed", unenrichedChunks: 0 } },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.chunk.status).toBe("failed");
    expect(r.git.chunk.message).toMatch(/crashed|recovered/i);
  });

  it("renders degraded / failed terminal statuses (matching runId), with errorMessage", () => {
    const map = {
      _run: run({ providers: ["codegraph.symbols"] }),
      codegraph: {
        symbols: {
          file: { runId: RUN, status: "failed", unenrichedChunks: 0, errorMessage: "spill failed" },
          chunk: { runId: RUN, status: "failed", unenrichedChunks: 0, errorMessage: "spill failed" },
        },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r["codegraph.symbols"].file.status).toBe("failed");
    expect(r["codegraph.symbols"].file.message).toContain("spill failed");
  });

  it("surfaces matchedFiles / missedFiles / durationMs on a healthy terminal", () => {
    const map = {
      _run: run(),
      git: {
        file: { runId: RUN, status: "completed", unenrichedChunks: 0, matchedFiles: 42, missedFiles: 3, durationMs: 0 },
        chunk: { runId: RUN, status: "completed", unenrichedChunks: 0 },
      },
    } as unknown as EnrichmentMarkerMap;
    const r = mapMarkerToHealth(map)!;
    expect(r.git.file.matchedFiles).toBe(42);
    expect(r.git.file.missedFiles).toBe(3);
    expect(r.git.file.durationMs).toBe(0);
  });

  it("returns undefined for empty map", () => {
    expect(mapMarkerToHealth({})).toBeUndefined();
  });

  describe("back-compat (no _run pointer — legacy literal-property shape)", () => {
    it("legacy completed → healthy, legacy pending → in_progress (never healthy)", () => {
      const map = {
        git: {
          file: { status: "completed", unenrichedChunks: 0 },
          chunk: { status: "pending", unenrichedChunks: 0 },
        },
      } as unknown as EnrichmentMarkerMap;
      const r = mapMarkerToHealth(map)!;
      expect(r.git.file.status).toBe("healthy");
      expect(r.git.chunk.status).toBe("in_progress");
    });

    it("legacy in_progress older than 1h with no completedAt → failed", () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const map = {
        git: {
          file: { status: "in_progress", unenrichedChunks: 4, startedAt: twoHoursAgo },
          chunk: { status: "pending", unenrichedChunks: 0 },
        },
      } as unknown as EnrichmentMarkerMap;
      const r = mapMarkerToHealth(map)!;
      expect(r.git.file.status).toBe("failed");
      expect(r.git.file.message).toMatch(/crashed|recovered/i);
    });

    it("legacy degraded chunk → degraded with message", () => {
      const map = {
        git: {
          file: { status: "completed", unenrichedChunks: 0 },
          chunk: { status: "degraded", unenrichedChunks: 8 },
        },
      } as unknown as EnrichmentMarkerMap;
      const r = mapMarkerToHealth(map)!;
      expect(r.git.chunk).toMatchObject({ status: "degraded", unenrichedChunks: 8 });
    });
  });
});
