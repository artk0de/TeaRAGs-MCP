import { describe, expect, it } from "vitest";

import type {
  EnrichmentHealthMap,
  EnrichmentMarkerMap,
  ProviderEnrichmentMarker,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

describe("Enrichment marker types", () => {
  it("should allow constructing a valid ProviderEnrichmentMarker", () => {
    const marker: ProviderEnrichmentMarker = {
      runId: "abc-123",
      file: {
        status: "completed",
        unenrichedChunks: 0,
        startedAt: "2026-03-27T10:00:00Z",
        completedAt: "2026-03-27T10:00:12Z",
        durationMs: 12000,
        matchedFiles: 100,
        missedFiles: 3,
      },
      chunk: {
        status: "degraded",
        unenrichedChunks: 5,
        startedAt: "2026-03-27T10:00:12Z",
      },
    };
    expect(marker.file.status).toBe("completed");
    expect(marker.chunk.status).toBe("degraded");
  });

  it("should allow constructing EnrichmentMarkerMap", () => {
    const map: EnrichmentMarkerMap = {
      git: {
        runId: "r1",
        file: { status: "failed", unenrichedChunks: 200 },
        chunk: { status: "failed", unenrichedChunks: 200 },
      },
    };
    expect(map.git.file.status).toBe("failed");
  });

  it("should allow constructing EnrichmentHealthMap", () => {
    const health: EnrichmentHealthMap = {
      git: {
        file: { status: "healthy" },
        chunk: {
          status: "degraded",
          unenrichedChunks: 5,
          message: "5 chunks missing",
        },
      },
    };
    expect(health.git.chunk.status).toBe("degraded");
  });
});
