import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProjectNameInvalidError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
} from "../../../../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { resolveCollection } from "../../../../../src/core/infra/collection-name.js";
import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";

describe("Project registry — additional coverage for merged branches", () => {
  let dir: string;
  let registry: CollectionRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-cov-"));
    registry = new CollectionRegistry(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("ProjectRegistryOps.register — invalid-name branches", () => {
    it("throws ProjectNameInvalidError('empty') on empty string", async () => {
      const ops = new ProjectRegistryOps({ registry });
      await expect(ops.register({ path: dir, name: "" })).rejects.toThrow(ProjectNameInvalidError);
      try {
        await ops.register({ path: dir, name: "" });
      } catch (e) {
        expect((e as Error).message).toContain("is empty");
      }
    });

    it("throws ProjectNameInvalidError('tooLong') for >64 chars", async () => {
      const ops = new ProjectRegistryOps({ registry });
      const tooLong = "a".repeat(65);
      await expect(ops.register({ path: dir, name: tooLong })).rejects.toThrow(ProjectNameInvalidError);
      try {
        await ops.register({ path: dir, name: tooLong });
      } catch (e) {
        expect((e as Error).message).toContain("exceeds maximum length");
      }
    });
  });

  describe("resolveCollection — populated registry path", () => {
    it("filters null names when reporting ProjectNotRegisteredError", () => {
      registry.record({
        collectionName: "code_named",
        path: "/repo/named",
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      registry.setName("code_named", "alpha");
      registry.record({
        collectionName: "code_unnamed",
        path: "/repo/unnamed",
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });

      try {
        resolveCollection(registry, { project: "ghost" });
        expect.fail("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ProjectNotRegisteredError);
        expect((e as Error).message).toContain("alpha");
        expect((e as Error).message).not.toContain("code_unnamed");
      }
    });

    it("throws StaleProjectAliasError when alias resolves to a deleted path", () => {
      // Reproduces the worktree-deletion bug: alias was registered for a
      // worktree that has since been removed. Without this guard, resolution
      // silently returns the stale path → callers operate on a phantom
      // (empty index, zero files) and write 0/0 stats.
      const stalePath = join(dir, "deleted-worktree");
      mkdirSync(stalePath);
      registry.record({
        collectionName: "code_stalealias",
        path: stalePath,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 1,
      });
      registry.setName("code_stalealias", "ghosted");
      // Delete the path the entry still references.
      rmSync(stalePath, { recursive: true, force: true });

      expect(() => resolveCollection(registry, { project: "ghosted" })).toThrow(StaleProjectAliasError);
      // Hint MUST mention the alias name AND the missing path so the user
      // knows what to re-register.
      try {
        resolveCollection(registry, { project: "ghosted" });
      } catch (e) {
        expect((e as Error).message).toContain("ghosted");
        expect((e as Error).message).toContain(stalePath);
      }
    });

    it("does NOT throw when alias path is empty string (recoverFromQdrant stubs)", () => {
      // recoverFromQdrant records entries with empty path. Those are detected
      // separately by ProjectPathMissingError downstream; resolveCollection
      // must not treat empty path as 'stale' (it's a legitimate stub).
      registry.record({
        collectionName: "code_stub",
        path: "",
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      registry.setName("code_stub", "stub");

      expect(() => resolveCollection(registry, { project: "stub" })).not.toThrow();
    });
  });

  describe("ProjectRegistryOps.register — stale-alias rename semantics", () => {
    it("RENAMES the alias: re-points the existing entry at the new path, preserves collectionName + chunksCount", async () => {
      // Skill `test-self-reindex` reuses the alias `tea-rags-worktree`
      // across worktrees. When the old worktree is gone, register() must
      // keep the existing entry's collectionName, chunksCount and other
      // metadata intact (so the physical Qdrant collection + snapshots +
      // codegraph DB all keep serving the project) and only update the
      // `path` field to the new worktree location. No data loss; no
      // re-indexing required.
      const oldPath = join(dir, "old-worktree");
      const newPath = join(dir, "new-worktree");
      mkdirSync(oldPath);
      mkdirSync(newPath);
      const ops = new ProjectRegistryOps({ registry });

      const first = await ops.register({ path: oldPath, name: "shared" });
      // Simulate that the project got indexed under the old path: bump
      // chunksCount so we can assert the rename preserves it.
      const existing = registry.get(first.collectionName);
      expect(existing).not.toBeNull();
      registry.record({
        collectionName: existing!.collectionName,
        path: existing!.path,
        embeddingModel: existing!.embeddingModel,
        embeddingDimensions: existing!.embeddingDimensions,
        qdrantUrl: existing!.qdrantUrl,
        indexedAt: "2026-05-01T00:00:00Z",
        teaRagsVersion: "1.0.0",
        chunksCount: 1234,
      });
      // User deletes old worktree, creates a new one with same alias intent.
      rmSync(oldPath, { recursive: true, force: true });

      const out = await ops.register({ path: newPath, name: "shared" });

      // Same collectionName — physical Qdrant collection survives the rename.
      expect(out.collectionName).toBe(first.collectionName);
      // Pre-existing index is preserved — return value reports it.
      expect(out.alreadyIndexed).toBe(true);
      // Entry now points at the NEW path. validatePath() runs realpath
      // under the hood (macOS resolves /var → /private/var); match the
      // same convention here so the assertion is platform-agnostic.
      const after = registry.get(first.collectionName);
      expect(after?.path).toBe(realpathSync(newPath));
      // chunksCount + metadata preserved.
      expect(after?.chunksCount).toBe(1234);
      expect(after?.indexedAt).toBe("2026-05-01T00:00:00Z");
      // The alias still owns this entry.
      expect(registry.findByName("shared")?.collectionName).toBe(first.collectionName);
    });

    it("still throws ProjectNameNotUniqueError when the conflicting path is LIVE (real collision)", async () => {
      // Rename semantics must only kick in for STALE entries — a legitimate
      // collision (two live worktrees both demanding the same alias) stays
      // a hard error so the user does not accidentally relabel a working
      // project by re-registering its name.
      const pathA = join(dir, "live-a");
      const pathB = join(dir, "live-b");
      mkdirSync(pathA);
      mkdirSync(pathB);
      const ops = new ProjectRegistryOps({ registry });
      await ops.register({ path: pathA, name: "contested" });
      await expect(ops.register({ path: pathB, name: "contested" })).rejects.toThrow(/not unique|contested/i);
    });

    it("path-based resolveCollection follows the rename (registry findByPath wins over hash)", async () => {
      // After a rename, resolveCollection({path: newPath}) MUST return the
      // preserved collectionName (not a fresh hash of the new path) —
      // otherwise downstream callers operate on an empty collection at
      // hash(newPath) instead of the real data at the preserved name.
      const oldPath = join(dir, "rn-old");
      const newPath = join(dir, "rn-new");
      mkdirSync(oldPath);
      mkdirSync(newPath);
      const ops = new ProjectRegistryOps({ registry });
      const first = await ops.register({ path: oldPath, name: "rn-alias" });
      rmSync(oldPath, { recursive: true, force: true });
      await ops.register({ path: newPath, name: "rn-alias" });

      // Path-based resolve returns the SAME collectionName as the alias
      // (the rename preserved it). Compare against realpath so the lookup
      // hits the registry entry that validatePath() wrote.
      const viaPath = resolveCollection(registry, { path: realpathSync(newPath) });
      expect(viaPath.collectionName).toBe(first.collectionName);
    });
  });
});
