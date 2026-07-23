import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CollectionNotProvidedError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
} from "../../../src/core/api/errors.js";
import { resolveCollection, resolveCollectionName, validatePath } from "../../../src/core/infra/collection-name.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/index.js";

describe("collection-name utilities", () => {
  describe("resolveCollectionName", () => {
    it("generates deterministic name from path", () => {
      const name = resolveCollectionName("/tmp/test-project");
      expect(name).toMatch(/^code_[a-f0-9]{8}$/);
    });

    it("returns same name for same path", () => {
      const a = resolveCollectionName("/tmp/test-project");
      const b = resolveCollectionName("/tmp/test-project");
      expect(a).toBe(b);
    });

    it("returns different names for different paths", () => {
      const a = resolveCollectionName("/tmp/project-a");
      const b = resolveCollectionName("/tmp/project-b");
      expect(a).not.toBe(b);
    });
  });

  describe("validatePath", () => {
    it("resolves existing path", async () => {
      const expected = await realpath("/tmp");
      const result = await validatePath("/tmp");
      expect(result).toBe(expected);
    });

    it("returns absolute path for non-existent path", async () => {
      const result = await validatePath("/nonexistent/path");
      expect(result).toBe("/nonexistent/path");
    });
  });

  describe("resolveCollection (new signature)", () => {
    let dir: string;
    let registry: CollectionRegistry;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "rc-"));
      registry = new CollectionRegistry(dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("priority 1: collection wins over everything", () => {
      const out = resolveCollection(registry, {
        collection: "explicit",
        project: "x",
        path: "/x",
      });
      expect(out.collectionName).toBe("explicit");
    });

    it("priority 2: project resolves via registry", () => {
      // Use a real, on-disk path — resolveCollection now guards against
      // stale aliases whose stored path no longer exists. The tmp `dir`
      // already serves as the live anchor in this suite's beforeEach.
      registry.record({
        collectionName: "code_abc",
        path: dir,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      registry.setName("code_abc", "alpha");
      const out = resolveCollection(registry, { project: "alpha" });
      expect(out.collectionName).toBe("code_abc");
      expect(out.path).toBe(dir);
    });

    it("priority 2 failure: unknown project throws ProjectNotRegisteredError", () => {
      expect(() => resolveCollection(registry, { project: "ghost" })).toThrow(ProjectNotRegisteredError);
    });

    it("priority 3: path computes deterministic hash", () => {
      const out = resolveCollection(registry, { path: "/some/abs/path" });
      expect(out.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
      expect(out.path).toBe("/some/abs/path");
    });

    it("priority 4: nothing -> CollectionNotProvidedError", () => {
      expect(() => resolveCollection(registry, {})).toThrow(CollectionNotProvidedError);
    });

    it("priority 2 failure: ProjectNotRegisteredError carries the available names", () => {
      registry.record({
        collectionName: "code_a",
        path: dir,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      registry.setName("code_a", "alpha");
      registry.record({
        collectionName: "code_b",
        path: dir,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      registry.setName("code_b", "beta");
      // Unknown alias surfaces the registered names so callers can recover.
      expect(() => resolveCollection(registry, { project: "ghost" })).toThrow(/alpha/);
      expect(() => resolveCollection(registry, { project: "ghost" })).toThrow(/beta/);
    });

    it("priority 2 stale alias: entry path missing from disk throws StaleProjectAliasError", () => {
      // `dir` exists but this sub-path never does — a moved/removed worktree.
      const gonePath = join(dir, "moved-away");
      registry.record({
        collectionName: "code_moved",
        path: gonePath,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      registry.setName("code_moved", "moved");
      expect(() => resolveCollection(registry, { project: "moved" })).toThrow(StaleProjectAliasError);
    });

    it("priority 2 recovery stub: empty entry path skips the stale guard", () => {
      // Empty path == recoverFromQdrant stub; NOT a stale alias, must resolve.
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
      const out = resolveCollection(registry, { project: "stub" });
      expect(out.collectionName).toBe("code_stub");
      expect(out.path).toBe("");
    });

    it("priority 3 moved alias: registered path returns the entry collectionName, not a fresh hash", () => {
      const movedPath = join(dir, "renamed-here");
      registry.record({
        collectionName: "code_old12345",
        path: movedPath,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });
      const out = resolveCollection(registry, { path: movedPath });
      expect(out.collectionName).toBe("code_old12345");
      expect(out.collectionName).not.toBe(resolveCollectionName(movedPath));
      expect(out.path).toBe(movedPath);
    });

    it("priority 3 fresh path: unregistered path falls back to md5-derived hash, deterministically", () => {
      const freshPath = "/unregistered/fresh/project";
      const first = resolveCollection(registry, { path: freshPath });
      const second = resolveCollection(registry, { path: freshPath });
      expect(first.collectionName).toBe(resolveCollectionName(freshPath));
      expect(second.collectionName).toBe(first.collectionName);
    });
  });
});
