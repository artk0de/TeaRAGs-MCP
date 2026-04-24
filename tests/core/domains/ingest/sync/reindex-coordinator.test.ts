import { describe, expect, it } from "vitest";

import { createDeletionOutcome } from "../../../../../src/core/domains/ingest/sync/deletion-outcome.js";
import { ReindexCoordinator } from "../../../../../src/core/domains/ingest/sync/reindex-coordinator.js";

describe("ReindexCoordinator", () => {
  it("allows upsert by default when no outcome has been applied", () => {
    const coordinator = new ReindexCoordinator();

    expect(coordinator.canUpsertForFile("anything")).toBe(true);
    expect(coordinator.hasBlockedPaths()).toBe(false);
    expect(coordinator.skippedFiles()).toEqual([]);
  });

  it("leaves all paths unblocked when applied outcome has empty failed set", () => {
    const coordinator = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["a.ts", "b.ts"]);

    coordinator.applyDeletionOutcome(outcome);

    expect(coordinator.hasBlockedPaths()).toBe(false);
    expect(coordinator.canUpsertForFile("a.ts")).toBe(true);
    expect(coordinator.canUpsertForFile("b.ts")).toBe(true);
  });

  it("blocks upsert for paths reported as failed in outcome", () => {
    const coordinator = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["a", "b", "c"]);
    outcome.markFailed("b");

    coordinator.applyDeletionOutcome(outcome);

    expect(coordinator.canUpsertForFile("a")).toBe(true);
    expect(coordinator.canUpsertForFile("b")).toBe(false);
    expect(coordinator.canUpsertForFile("c")).toBe(true);
    expect(coordinator.hasBlockedPaths()).toBe(true);
  });

  it("records blocked paths in skippedFiles but ignores allowed paths", () => {
    const coordinator = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["a", "b"]);
    outcome.markFailed("b");

    coordinator.applyDeletionOutcome(outcome);
    coordinator.canUpsertForFile("b");
    coordinator.canUpsertForFile("a");

    expect(coordinator.skippedFiles()).toEqual(["b"]);
  });

  it("accumulates blocked paths across multiple applyDeletionOutcome calls", () => {
    const coordinator = new ReindexCoordinator();

    const first = createDeletionOutcome(["a", "b"]);
    first.markFailed("b");
    coordinator.applyDeletionOutcome(first);

    const second = createDeletionOutcome(["c", "d"]);
    second.markFailed("d");
    coordinator.applyDeletionOutcome(second);

    expect(coordinator.canUpsertForFile("b")).toBe(false);
    expect(coordinator.canUpsertForFile("d")).toBe(false);
    expect(coordinator.hasBlockedPaths()).toBe(true);
  });

  it("records every canUpsertForFile skip for the same blocked path", () => {
    const coordinator = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["b"]);
    outcome.markFailed("b");

    coordinator.applyDeletionOutcome(outcome);

    expect(coordinator.canUpsertForFile("b")).toBe(false);
    expect(coordinator.canUpsertForFile("b")).toBe(false);
    expect(coordinator.canUpsertForFile("b")).toBe(false);
    expect(coordinator.skippedFiles()).toEqual(["b", "b", "b"]);
  });

  it("returns a fresh skippedFiles snapshot that cannot mutate internal state", () => {
    const coordinator = new ReindexCoordinator();
    const outcome = createDeletionOutcome(["b"]);
    outcome.markFailed("b");

    coordinator.applyDeletionOutcome(outcome);
    coordinator.canUpsertForFile("b");

    const snap = coordinator.skippedFiles();
    (snap as string[]).push("x");

    expect(coordinator.skippedFiles()).not.toContain("x");
    expect(coordinator.skippedFiles()).toEqual(["b"]);
  });
});
