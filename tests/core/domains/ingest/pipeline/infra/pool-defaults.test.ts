import os from "node:os";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultChunkerPoolSize,
  defaultEnrichmentWorkerCpuProfileDir,
  defaultEnrichmentWorkerMemoryLimitMb,
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

/**
 * bd tea-rags-mcp-8qf86 — a runaway enrichment worker must fail itself long
 * before it can swap the host machine.
 *
 * The incident this guards against ran the codegraph recompute to 2.6 GB RSS,
 * still climbing after 46 minutes, taking host swap to 92% full and free RAM to
 * ~50 MB before the process tree was killed by hand. A heap ceiling turns that
 * into an ordinary `ERR_WORKER_OUT_OF_MEMORY`: loud, immediate, attributable to
 * one worker, and survivable by everything else on the machine.
 */
describe("defaultEnrichmentWorkerMemoryLimitMb", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB;
    delete process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB = savedEnv;
    } else {
      delete process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB;
    }
  });

  it("defaults to 2048 MB when ENRICHMENT_WORKER_MEMORY_LIMIT_MB is not set", () => {
    expect(defaultEnrichmentWorkerMemoryLimitMb()).toBe(2048);
  });

  it("returns the parsed value when the override is a valid positive integer", () => {
    process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB = "512";
    expect(defaultEnrichmentWorkerMemoryLimitMb()).toBe(512);
  });

  it("returns 0 when the override is '0', removing the ceiling", () => {
    process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB = "0";
    expect(defaultEnrichmentWorkerMemoryLimitMb()).toBe(0);
  });

  it("falls back to the default when the override is not a number", () => {
    process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB = "not-a-number";
    expect(defaultEnrichmentWorkerMemoryLimitMb()).toBe(2048);
  });

  it("falls back to the default when the override is negative", () => {
    process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB = "-1";
    expect(defaultEnrichmentWorkerMemoryLimitMb()).toBe(2048);
  });

  it("falls back to the default when the override is only whitespace", () => {
    process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB = "   ";
    expect(defaultEnrichmentWorkerMemoryLimitMb()).toBe(2048);
  });
});

/**
 * Diagnostic-only knob for attaching `--cpu-prof` to enrichment worker
 * threads. Unlike the memory ceiling, off (`undefined`) is the correct
 * default: profiling overhead has no business being paid on an ordinary run.
 */
describe("defaultEnrichmentWorkerCpuProfileDir", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR;
    delete process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR;
  });

  afterEach(() => {
    if (savedEnv !== undefined) {
      process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR = savedEnv;
    } else {
      delete process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR;
    }
  });

  it("returns undefined when ENRICHMENT_WORKER_CPU_PROFILE_DIR is not set", () => {
    expect(defaultEnrichmentWorkerCpuProfileDir()).toBeUndefined();
  });

  it("returns the configured directory when set", () => {
    process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR = "/tmp/profiles";
    expect(defaultEnrichmentWorkerCpuProfileDir()).toBe("/tmp/profiles");
  });

  it("returns undefined when the override is only whitespace", () => {
    process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR = "   ";
    expect(defaultEnrichmentWorkerCpuProfileDir()).toBeUndefined();
  });
});
