import { describe, expect, it } from "vitest";

import { createDeletionOutcome } from "../../../../../src/core/domains/ingest/sync/deletion-outcome.js";

describe("createDeletionOutcome", () => {
  it("handles empty input", () => {
    const outcome = createDeletionOutcome([]);

    expect(outcome.succeeded.size).toBe(0);
    expect(outcome.failed.size).toBe(0);
    expect(outcome.isFullSuccess()).toBe(true);
    expect(outcome.chunksDeleted).toBe(0);
  });

  it("marks a single path as failed", () => {
    const outcome = createDeletionOutcome(["a", "b", "c"]);

    outcome.markFailed("b");

    expect(outcome.succeeded.has("a")).toBe(true);
    expect(outcome.succeeded.has("c")).toBe(true);
    expect(outcome.succeeded.has("b")).toBe(false);
    expect(outcome.succeeded.size).toBe(2);
    expect(outcome.failed.has("b")).toBe(true);
    expect(outcome.failed.size).toBe(1);
    expect(outcome.isFullSuccess()).toBe(false);
  });

  it("marks all attempted paths as failed", () => {
    const outcome = createDeletionOutcome(["a", "b"]);

    outcome.markAllFailed();

    expect(outcome.succeeded.size).toBe(0);
    expect(outcome.failed.size).toBe(2);
    expect(outcome.failed.has("a")).toBe(true);
    expect(outcome.failed.has("b")).toBe(true);
    expect(outcome.isFullSuccess()).toBe(false);
  });

  it("is idempotent for paths not in the attempted set", () => {
    const outcome = createDeletionOutcome(["a"]);

    outcome.markFailed("nonexistent");

    expect(outcome.succeeded.has("a")).toBe(true);
    expect(outcome.succeeded.size).toBe(1);
    expect(outcome.failed.size).toBe(0);
  });

  it("does not throw when markFailed is called twice on the same path", () => {
    const outcome = createDeletionOutcome(["a"]);

    outcome.markFailed("a");
    outcome.markFailed("a");

    expect(outcome.failed.has("a")).toBe(true);
    expect(outcome.failed.size).toBe(1);
    expect(outcome.succeeded.size).toBe(0);
  });

  it("exposes a mutable chunksDeleted counter", () => {
    const outcome = createDeletionOutcome(["a"]);

    expect(outcome.chunksDeleted).toBe(0);

    outcome.chunksDeleted = 42;

    expect(outcome.chunksDeleted).toBe(42);
  });

  it("reflects state transitions in isFullSuccess", () => {
    const outcome = createDeletionOutcome(["a"]);

    expect(outcome.isFullSuccess()).toBe(true);

    outcome.markFailed("a");

    expect(outcome.isFullSuccess()).toBe(false);
  });
});
