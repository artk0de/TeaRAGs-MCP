import { describe, expect, it, vi, afterEach } from "vitest";

import { mapMarkerToHealth } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/health-mapper.js";
import type {
  EnrichmentMarkerMap,
  ProviderEnrichmentMarker,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

function makeMarker(overrides: Partial<ProviderEnrichmentMarker> = {}): ProviderEnrichmentMarker {
  return {
    runId: "test-run",
    file: { status: "completed", unenrichedChunks: 0 },
    chunk: { status: "completed", unenrichedChunks: 0 },
    ...overrides,
  };
}

describe("mapMarkerToHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns undefined for empty marker map", () => {
    expect(mapMarkerToHealth({})).toBeUndefined();
  });

  it("returns undefined when markers have no file/chunk", () => {
    const map = { git: {} } as unknown as EnrichmentMarkerMap;
    expect(mapMarkerToHealth(map)).toBeUndefined();
  });

  it("maps completed file + completed chunk to both healthy", () => {
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "completed", unenrichedChunks: 0 },
        chunk: { status: "completed", unenrichedChunks: 0 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result).toEqual({
      git: {
        file: { status: "healthy" },
        chunk: { status: "healthy" },
      },
    });
  });

  it("maps failed file to failed status with message", () => {
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "failed", unenrichedChunks: 5 },
        chunk: { status: "completed", unenrichedChunks: 0 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result!.git.file).toEqual({
      status: "failed",
      unenrichedChunks: 5,
      message: "Git file enrichment failed. Will recover on next reindex.",
    });
  });

  it("maps degraded chunk to degraded status with unenrichedChunks and message", () => {
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "completed", unenrichedChunks: 0 },
        chunk: { status: "degraded", unenrichedChunks: 12 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result!.git.chunk).toEqual({
      status: "degraded",
      unenrichedChunks: 12,
      message: "12 chunks missing chunk-level signals. Will recover on next reindex.",
    });
  });

  it("maps in_progress with fresh lastProgressAt to in_progress without stale warning", () => {
    const now = new Date().toISOString();
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "in_progress", unenrichedChunks: 3, lastProgressAt: now },
        chunk: { status: "pending", unenrichedChunks: 0 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result!.git.file).toEqual({
      status: "in_progress",
      message: "Enrichment in progress...",
    });
  });

  it("maps in_progress with stale lastProgressAt to in_progress with stale warning", () => {
    const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "completed", unenrichedChunks: 0 },
        chunk: { status: "in_progress", unenrichedChunks: 7, lastProgressAt: threeMinutesAgo },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result!.git.chunk).toEqual({
      status: "in_progress",
      message: "Enrichment appears stalled — no progress in 2 minutes. May need reindex.",
    });
  });

  it("maps in_progress without lastProgressAt to in_progress (not stale)", () => {
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "in_progress", unenrichedChunks: 2 },
        chunk: { status: "pending", unenrichedChunks: 0 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result!.git.file).toEqual({
      status: "in_progress",
      message: "Enrichment in progress...",
    });
  });

  it("maps pending to healthy (not started is not a problem)", () => {
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "pending", unenrichedChunks: 0 },
        chunk: { status: "pending", unenrichedChunks: 0 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result).toEqual({
      git: {
        file: { status: "healthy" },
        chunk: { status: "healthy" },
      },
    });
  });

  it("handles multiple providers", () => {
    const map: EnrichmentMarkerMap = {
      git: makeMarker({
        file: { status: "completed", unenrichedChunks: 0 },
        chunk: { status: "completed", unenrichedChunks: 0 },
      }),
      metrics: makeMarker({
        file: { status: "failed", unenrichedChunks: 3 },
        chunk: { status: "degraded", unenrichedChunks: 8 },
      }),
    };

    const result = mapMarkerToHealth(map);
    expect(result!.git.file.status).toBe("healthy");
    expect(result!.metrics.file.status).toBe("failed");
    expect(result!.metrics.chunk.status).toBe("degraded");
  });
});
