import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantOptimizerErrorPersistsError } from "../../../../../src/core/adapters/qdrant/errors.js";
import { OptimizerRecoveryOps } from "../../../../../src/core/api/internal/ops/optimizer-recovery-ops.js";
import {
  isOptimizerFailure,
  renderOptimizerRecoveryCommand,
} from "../../../../../src/core/contracts/optimizer-recovery.js";
import { NotIndexedError } from "../../../../../src/core/domains/ingest/errors.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

/**
 * `tea-rags qdrant recover` (bd tea-rags-mcp-ye5o, owner option B).
 *
 * Qdrant 1.18 (#8767) recreates a collection's optimizer on a collection
 * update, which clears a recorded optimizer error. The op reads the optimizer
 * status of the project's PHYSICAL collection, issues the no-op update only
 * when that status is an error, and verifies the error is gone.
 */
describe("OptimizerRecoveryOps#recover", () => {
  let dataDir: string;
  let projectDir: string;
  let registry: CollectionRegistry;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "optimizer-recovery-data-"));
    projectDir = mkdtempSync(join(tmpdir(), "optimizer-recovery-project-"));
    registry = new CollectionRegistry(dataDir);
    registry.record({
      collectionName: "code_abc",
      path: projectDir,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://q",
      indexedAt: "2026-09-01T00:00:00.000Z",
      teaRagsVersion: "1.0.0",
      chunksCount: 42,
    });
    registry.setName("code_abc", "demo");
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** Qdrant seam: optimizer status per read, in order; the alias resolves to `_v2`. */
  function qdrantReporting(...statuses: string[]) {
    const reads = [...statuses];
    return {
      collectionExists: vi.fn(async () => true),
      getCollectionInfo: vi.fn(async () => ({ optimizerStatus: reads.shift() ?? "ok" })),
      reapplyOptimizerConfig: vi.fn(async () => {}),
      aliases: { resolveActive: vi.fn(async (name: string) => `${name}_v2`) },
    };
  }

  it("re-applies the optimizer config of the physical collection when the optimizer failed, then reports it cleared", async () => {
    const qdrant = qdrantReporting("error: segment optimization failed", "ok");
    const ops = new OptimizerRecoveryOps({ registry, qdrant });

    const result = await ops.recover({ project: "demo" });

    expect(qdrant.aliases.resolveActive).toHaveBeenCalledWith("code_abc");
    expect(qdrant.reapplyOptimizerConfig).toHaveBeenCalledTimes(1);
    expect(qdrant.reapplyOptimizerConfig).toHaveBeenCalledWith("code_abc_v2");
    expect(qdrant.getCollectionInfo).toHaveBeenNthCalledWith(1, "code_abc_v2");
    expect(qdrant.getCollectionInfo).toHaveBeenNthCalledWith(2, "code_abc_v2");
    expect(result).toEqual({
      outcome: "cleared",
      collectionName: "code_abc_v2",
      previousOptimizerStatus: "error: segment optimization failed",
      optimizerStatus: "ok",
    });
  });

  it("issues no update when the optimizer is not in an error state", async () => {
    const qdrant = qdrantReporting("ok");
    const ops = new OptimizerRecoveryOps({ registry, qdrant });

    const result = await ops.recover({ project: "demo" });

    expect(qdrant.reapplyOptimizerConfig).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "nothing-to-do", collectionName: "code_abc_v2", optimizerStatus: "ok" });
  });

  it("throws a typed error when the optimizer still reports an error after the update", async () => {
    const qdrant = qdrantReporting("error: disk full", "error: disk full");
    const ops = new OptimizerRecoveryOps({ registry, qdrant });

    const failure = ops.recover({ project: "demo" });

    await expect(failure).rejects.toBeInstanceOf(QdrantOptimizerErrorPersistsError);
    await expect(failure).rejects.toThrow(/code_abc_v2.*disk full/);
    expect(qdrant.reapplyOptimizerConfig).toHaveBeenCalledTimes(1);
  });

  it("resolves the collection from the project path when no alias is given", async () => {
    const qdrant = qdrantReporting("ok");
    const ops = new OptimizerRecoveryOps({ registry, qdrant });

    await ops.recover({ path: projectDir });

    expect(qdrant.aliases.resolveActive).toHaveBeenCalledWith("code_abc");
  });

  // bd tea-rags-mcp-61bwb: `qdrant recover --path /tmp` on a path that was
  // never indexed dumped Qdrant's raw `ApiError: Not Found` (and yargs help).
  it("throws the typed not-indexed error when the project has no collection, touching nothing", async () => {
    const unindexed = mkdtempSync(join(tmpdir(), "optimizer-recovery-unindexed-"));
    try {
      const qdrant = { ...qdrantReporting("ok"), collectionExists: vi.fn(async () => false) };
      qdrant.aliases.resolveActive.mockImplementation(async (name: string) => name);
      const ops = new OptimizerRecoveryOps({ registry, qdrant });

      const failure = ops.recover({ path: unindexed });

      await expect(failure).rejects.toBeInstanceOf(NotIndexedError);
      await expect(failure).rejects.toThrow(unindexed);
      expect(qdrant.getCollectionInfo).not.toHaveBeenCalled();
      expect(qdrant.reapplyOptimizerConfig).not.toHaveBeenCalled();
    } finally {
      rmSync(unindexed, { recursive: true, force: true });
    }
  });
});

describe("isOptimizerFailure", () => {
  it("is true only for the rendered error arm of the optimizer status", () => {
    expect(isOptimizerFailure("error: segment optimization failed")).toBe(true);
    expect(isOptimizerFailure("ok")).toBe(false);
    expect(isOptimizerFailure("unknown")).toBe(false);
    expect(isOptimizerFailure(undefined)).toBe(false);
  });
});

describe("renderOptimizerRecoveryCommand", () => {
  it("addresses the project by alias when one is known", () => {
    expect(renderOptimizerRecoveryCommand({ project: "tea-rags", path: "/repo" })).toBe(
      "Run: tea-rags qdrant recover --project tea-rags",
    );
  });

  it("falls back to the project path, quoted when the shell would split it", () => {
    expect(renderOptimizerRecoveryCommand({ path: "/repo" })).toBe("Run: tea-rags qdrant recover --path /repo");
    expect(renderOptimizerRecoveryCommand({ path: "/my repo" })).toBe("Run: tea-rags qdrant recover --path '/my repo'");
  });
});
