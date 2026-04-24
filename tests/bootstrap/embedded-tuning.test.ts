/**
 * Tests for applyEmbeddedDeleteTuning — embedded-aware delete defaults.
 *
 * On embedded Qdrant, WAL serializes all writes, so parallel deletes only
 * block the HTTP client without real parallelism. These tests verify that
 * delete tuning is overridden on embedded mode unless the user set env
 * explicitly.
 */
import { describe, expect, it } from "vitest";

import { applyEmbeddedDeleteTuning } from "../../src/bootstrap/config/embedded-tuning.js";
import type { QdrantTuneConfig } from "../../src/core/contracts/types/config.js";

const baseTune: QdrantTuneConfig = {
  upsertBatchSize: 512,
  upsertFlushIntervalMs: 250,
  upsertOrdering: "strong",
  deleteBatchSize: 1000,
  deleteConcurrency: 4,
  deleteFlushTimeoutMs: 1000,
  quantizationScalar: false,
};

const noneUserSet = { deleteBatchSize: false, deleteConcurrency: false };

describe("applyEmbeddedDeleteTuning", () => {
  it("overrides deleteBatchSize to 200 and deleteConcurrency to 1 on embedded when user didn't set env", () => {
    const result = applyEmbeddedDeleteTuning(baseTune, "embedded", noneUserSet);

    expect(result.deleteBatchSize).toBe(200);
    expect(result.deleteConcurrency).toBe(1);
  });

  it("keeps user-set deleteBatchSize on embedded", () => {
    const result = applyEmbeddedDeleteTuning(baseTune, "embedded", {
      deleteBatchSize: true,
      deleteConcurrency: false,
    });

    expect(result.deleteBatchSize).toBe(1000);
    expect(result.deleteConcurrency).toBe(1);
  });

  it("keeps user-set deleteConcurrency on embedded", () => {
    const result = applyEmbeddedDeleteTuning(baseTune, "embedded", {
      deleteBatchSize: false,
      deleteConcurrency: true,
    });

    expect(result.deleteBatchSize).toBe(200);
    expect(result.deleteConcurrency).toBe(4);
  });

  it("does not touch tune on external mode", () => {
    const result = applyEmbeddedDeleteTuning(baseTune, "external", noneUserSet);

    expect(result).toEqual(baseTune);
  });

  it("preserves other tune fields on embedded override", () => {
    const result = applyEmbeddedDeleteTuning(baseTune, "embedded", noneUserSet);

    expect(result.upsertBatchSize).toBe(512);
    expect(result.upsertOrdering).toBe("strong");
    expect(result.deleteFlushTimeoutMs).toBe(1000);
  });
});
