/**
 * DeletionRetryHelper — extraction tests (TDD RED phase).
 *
 * Pins the contract of the soon-to-exist `DeletionRetryHelper` extracted from
 * `performDeletion`. The helper owns the per-path retry + outcome accumulation
 * boundary that currently lives inline in the L2 fallback branch of
 * `deletion-strategy.ts`.
 *
 * Failing reason (T9 / T10):
 *   src/core/domains/ingest/sync/deletion-retry-helper.ts does not exist yet.
 *   These tests RED until M2.A.3 lands the helper.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { DeletionRetryHelper } from "../../../../../src/core/domains/ingest/sync/deletion-retry-helper.js";

describe("DeletionRetryHelper partial outcome", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns succeeded + failed sets when some ids fail to delete", async () => {
    const helper = new DeletionRetryHelper({ maxRetries: 1, backoffMs: 0 });

    const attempt = vi.fn(async (ids: string[]) => {
      if (ids.includes("B")) {
        throw new Error("simulated qdrant error");
      }
    });

    const outcome = await helper.execute(["A", "B", "C"], attempt);

    expect(outcome.succeeded).toEqual(new Set(["A", "C"]));
    expect(outcome.failed).toEqual(new Set(["B"]));
  });

  it("emits failed entry per id when retries exhaust", async () => {
    const helper = new DeletionRetryHelper({ maxRetries: 2, backoffMs: 0 });

    let attempts = 0;
    const attempt = vi.fn(async () => {
      attempts++;
      throw new Error("transient error");
    });

    const outcome = await helper.execute(["X"], attempt);

    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(outcome.failed.has("X")).toBe(true);
    expect(outcome.succeeded.size).toBe(0);
  });
});
