import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

/**
 * `listStale` / `pruneStale` — the sweep behind `tea-rags projects prune`
 * (bd tea-rags-mcp-qwhmy).
 *
 * The registry accumulates entries whose project directory is gone: test
 * fixtures under a temp dir, removed worktrees. A NAMED stale entry is
 * recoverable — `register` re-points it when its alias is registered at the
 * new path — so only the NAMELESS ones are prunable.
 */
describe("ProjectRegistryOps stale-entry sweep", () => {
  let dir: string;
  let registry: CollectionRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pro-stale-"));
    registry = new CollectionRegistry(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(input: {
    collectionName: string;
    path: string;
    name?: string;
    chunksCount?: number;
    worktreeOf?: string;
  }): void {
    registry.record({
      collectionName: input.collectionName,
      path: input.path,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://q",
      indexedAt: "2026-09-01T00:00:00.000Z",
      teaRagsVersion: "1.0.0",
      chunksCount: input.chunksCount ?? 42,
      ...(input.worktreeOf !== undefined ? { worktreeOf: input.worktreeOf } : {}),
    });
    if (input.name !== undefined) registry.setName(input.collectionName, input.name);
  }

  /** Path existence seam: only the listed paths are on disk. */
  function opsWith(present: string[]): ProjectRegistryOps {
    const onDisk = new Set(present);
    return new ProjectRegistryOps({ registry, pathExists: (p) => onDisk.has(p) });
  }

  describe("listStale", () => {
    it("skips entries whose directory is still on disk", () => {
      seed({ collectionName: "code_live", path: "/live/repo", name: "live" });

      expect(opsWith(["/live/repo"]).listStale()).toEqual([]);
    });

    it("skips empty-path entries — recoverFromQdrant stubs have no directory to miss", () => {
      seed({ collectionName: "code_stub", path: "" });

      expect(opsWith([]).listStale()).toEqual([]);
    });

    it("returns the nameless AND the named entries whose directory is gone", () => {
      seed({ collectionName: "code_ghost", path: "/gone/fixture", chunksCount: 7 });
      seed({ collectionName: "code_moved", path: "/gone/worktree", name: "moved", chunksCount: 9 });
      seed({ collectionName: "code_live", path: "/live/repo", name: "live" });

      const stale = opsWith(["/live/repo"]).listStale();

      expect(stale).toEqual([
        {
          collectionName: "code_ghost",
          name: null,
          path: "/gone/fixture",
          chunksCount: 7,
          indexedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          collectionName: "code_moved",
          name: "moved",
          path: "/gone/worktree",
          chunksCount: 9,
          indexedAt: "2026-09-01T00:00:00.000Z",
        },
      ]);
    });

    it("carries worktreeOf so a stale clone is recognizable as one", () => {
      seed({ collectionName: "code_clone", path: "/gone/wt", worktreeOf: "code_source" });

      expect(opsWith([]).listStale()[0]?.worktreeOf).toBe("code_source");
    });

    it("asks the real filesystem when no seam is injected", () => {
      const live = join(dir, "repo");
      mkdirSync(live);
      writeFileSync(join(live, ".keep"), "");
      seed({ collectionName: "code_live", path: live, name: "live" });
      seed({ collectionName: "code_ghost", path: join(dir, "vanished") });

      const stale = new ProjectRegistryOps({ registry }).listStale();

      expect(stale.map((e) => e.collectionName)).toEqual(["code_ghost"]);
    });
  });

  describe("pruneStale", () => {
    it("removes the nameless stale entries and reports them", () => {
      seed({ collectionName: "code_ghost", path: "/gone/fixture" });

      const report = opsWith([]).pruneStale();

      expect(report.removed.map((e) => e.collectionName)).toEqual(["code_ghost"]);
      expect(report.kept).toEqual([]);
      expect(registry.get("code_ghost")).toBeNull();
    });

    it("keeps a named stale entry — its alias re-points on the next register", () => {
      seed({ collectionName: "code_moved", path: "/gone/worktree", name: "moved" });

      const report = opsWith([]).pruneStale();

      expect(report.removed).toEqual([]);
      expect(report.kept.map((e) => e.name)).toEqual(["moved"]);
      expect(registry.get("code_moved")).not.toBeNull();
    });

    it("never touches an entry whose directory exists, named or not", () => {
      seed({ collectionName: "code_live", path: "/live/repo" });
      seed({ collectionName: "code_named", path: "/live/other", name: "other" });

      const report = opsWith(["/live/repo", "/live/other"]).pruneStale();

      expect(report).toEqual({ removed: [], kept: [] });
      expect(registry.list()).toHaveLength(2);
    });

    it("leaves a blocked entry in place so a failed footprint purge can be retried", () => {
      seed({ collectionName: "code_blocked", path: "/gone/a" });
      seed({ collectionName: "code_ok", path: "/gone/b" });

      const report = opsWith([]).pruneStale({ blocked: new Set(["code_blocked"]) });

      expect(report.removed.map((e) => e.collectionName)).toEqual(["code_ok"]);
      expect(report.kept.map((e) => e.collectionName)).toEqual(["code_blocked"]);
      expect(registry.get("code_blocked")).not.toBeNull();
      expect(registry.get("code_ok")).toBeNull();
    });

    it("reports an entry as kept when the registry refuses the removal", () => {
      seed({ collectionName: "code_ghost", path: "/gone/fixture" });
      const remove = vi.spyOn(registry, "remove").mockReturnValue(false);
      try {
        const report = opsWith([]).pruneStale();

        expect(report.removed).toEqual([]);
        expect(report.kept.map((e) => e.collectionName)).toEqual(["code_ghost"]);
      } finally {
        remove.mockRestore();
      }
    });
  });
});
