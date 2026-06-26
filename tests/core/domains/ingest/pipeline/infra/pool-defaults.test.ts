import os from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultChunkerPoolSize,
  defaultWorkerDispatchTimeoutMs,
} from "../../../../../../src/core/domains/ingest/pipeline/infra/pool-defaults.js";

describe("defaultChunkerPoolSize", () => {
  it("defaults the chunker pool to min(4, cpus-1), at least 1", () => {
    const expected = Math.max(1, Math.min(4, os.cpus().length - 1));
    expect(defaultChunkerPoolSize()).toBe(expected);
    expect(defaultChunkerPoolSize()).toBeGreaterThanOrEqual(1);
  });
});

describe("defaultWorkerDispatchTimeoutMs", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CHUNKER_WORKER_TIMEOUT_MS;
    delete process.env.CHUNKER_WORKER_TIMEOUT_MS;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.CHUNKER_WORKER_TIMEOUT_MS = savedEnv;
    } else {
      delete process.env.CHUNKER_WORKER_TIMEOUT_MS;
    }
  });

  it("returns 120000 when CHUNKER_WORKER_TIMEOUT_MS is not set", () => {
    expect(defaultWorkerDispatchTimeoutMs()).toBe(120_000);
  });

  it("returns the parsed value when CHUNKER_WORKER_TIMEOUT_MS is a valid positive integer", () => {
    process.env.CHUNKER_WORKER_TIMEOUT_MS = "30000";
    expect(defaultWorkerDispatchTimeoutMs()).toBe(30_000);
  });

  it("returns 0 when CHUNKER_WORKER_TIMEOUT_MS is '0' (disables the liveness bound)", () => {
    process.env.CHUNKER_WORKER_TIMEOUT_MS = "0";
    expect(defaultWorkerDispatchTimeoutMs()).toBe(0);
  });

  it("falls back to 120000 when CHUNKER_WORKER_TIMEOUT_MS is not a valid number (NaN)", () => {
    process.env.CHUNKER_WORKER_TIMEOUT_MS = "not-a-number";
    expect(defaultWorkerDispatchTimeoutMs()).toBe(120_000);
  });

  it("falls back to 120000 when CHUNKER_WORKER_TIMEOUT_MS is a negative integer", () => {
    process.env.CHUNKER_WORKER_TIMEOUT_MS = "-1";
    expect(defaultWorkerDispatchTimeoutMs()).toBe(120_000);
  });

  it("falls back to 120000 when CHUNKER_WORKER_TIMEOUT_MS is only whitespace", () => {
    process.env.CHUNKER_WORKER_TIMEOUT_MS = "   ";
    expect(defaultWorkerDispatchTimeoutMs()).toBe(120_000);
  });
});
