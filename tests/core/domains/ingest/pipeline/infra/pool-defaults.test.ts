import os from "node:os";

import { describe, expect, it } from "vitest";

import { defaultChunkerPoolSize } from "../../../../../../src/core/domains/ingest/pipeline/infra/pool-defaults.js";

describe("defaultChunkerPoolSize", () => {
  it("defaults the chunker pool to min(4, cpus-1), at least 1", () => {
    const expected = Math.max(1, Math.min(4, os.cpus().length - 1));
    expect(defaultChunkerPoolSize()).toBe(expected);
    expect(defaultChunkerPoolSize()).toBeGreaterThanOrEqual(1);
  });
});
