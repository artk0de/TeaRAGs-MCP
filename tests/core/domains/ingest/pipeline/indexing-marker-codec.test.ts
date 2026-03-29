import { describe, expect, it } from "vitest";

import {
  parseMarkerPayload,
  serializeMarkerPayload,
} from "../../../../../src/core/domains/ingest/pipeline/indexing-marker-codec.js";

describe("parseMarkerPayload", () => {
  it("parses complete valid payload", () => {
    const raw = {
      indexingComplete: true,
      startedAt: "2026-03-29T10:00:00.000Z",
      completedAt: "2026-03-29T10:05:00.000Z",
      lastHeartbeat: "2026-03-29T10:04:30.000Z",
      embeddingModel: "jina-embeddings-v2-base-code",
      enrichment: { git: { file: { status: "completed" } } },
    };
    const parsed = parseMarkerPayload(raw);
    expect(parsed.indexingComplete).toBe(true);
    expect(parsed.completedAt).toBe("2026-03-29T10:05:00.000Z");
    expect(parsed.embeddingModel).toBe("jina-embeddings-v2-base-code");
  });

  it("normalizes numeric completedAt to ISO string", () => {
    const raw = {
      indexingComplete: true,
      completedAt: 1774714982000,
    };
    const parsed = parseMarkerPayload(raw);
    expect(typeof parsed.completedAt).toBe("string");
    expect(parsed.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("handles Date completedAt", () => {
    const raw = {
      indexingComplete: true,
      completedAt: new Date("2026-03-29T10:00:00.000Z"),
    };
    const parsed = parseMarkerPayload(raw);
    expect(parsed.completedAt).toBe("2026-03-29T10:00:00.000Z");
  });

  it("defaults indexingComplete to false when missing", () => {
    const parsed = parseMarkerPayload({});
    expect(parsed.indexingComplete).toBe(false);
  });

  it("ignores non-string embeddingModel", () => {
    const parsed = parseMarkerPayload({ embeddingModel: 123 });
    expect(parsed.embeddingModel).toBeUndefined();
  });

  it("ignores non-string lastHeartbeat", () => {
    const parsed = parseMarkerPayload({ lastHeartbeat: 123 });
    expect(parsed.lastHeartbeat).toBeUndefined();
  });

  it("preserves enrichment object as-is", () => {
    const enrichment = { git: { file: { status: "completed" } } };
    const parsed = parseMarkerPayload({ enrichment });
    expect(parsed.enrichment).toBe(enrichment);
  });

  it("returns undefined enrichment when absent", () => {
    const parsed = parseMarkerPayload({});
    expect(parsed.enrichment).toBeUndefined();
  });
});

describe("serializeMarkerPayload", () => {
  it("serializes start marker", () => {
    const result = serializeMarkerPayload({
      indexingComplete: false,
      startedAt: "2026-03-29T10:00:00.000Z",
      embeddingModel: "model-x",
    });
    expect(result.indexingComplete).toBe(false);
    expect(result.startedAt).toBe("2026-03-29T10:00:00.000Z");
    expect(result.embeddingModel).toBe("model-x");
  });

  it("serializes completion marker", () => {
    const result = serializeMarkerPayload({
      indexingComplete: true,
      completedAt: "2026-03-29T10:05:00.000Z",
    });
    expect(result.indexingComplete).toBe(true);
    expect(result.completedAt).toBe("2026-03-29T10:05:00.000Z");
  });

  it("omits undefined fields", () => {
    const result = serializeMarkerPayload({ indexingComplete: true });
    expect("startedAt" in result).toBe(false);
    expect("completedAt" in result).toBe(false);
  });
});
