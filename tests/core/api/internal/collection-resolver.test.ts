import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CollectionNotProvidedError,
  ProjectNotRegisteredError,
  StaleProjectAliasError,
} from "../../../../src/core/api/errors.js";
import {
  createPathCollectionResolver,
  resolveCollection,
} from "../../../../src/core/api/internal/collection-resolver.js";
import { CollectionRegistry } from "../../../../src/core/domains/maintenance/registry/index.js";
import { resolveCollectionName, validatePath } from "../../../../src/core/infra/collection-name.js";

describe("collection-resolver", () => {
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

    it("priority 3 legacy spelling: an entry recorded non-canonically is still found", () => {
      // Two things at once (bd tea-rags-mcp-dxa9w re-review NEW-4). The lookup
      // tries the plain resolved spelling BEFORE canonicalizing, so the serving
      // query path pays no realpath syscall for a registered project — and
      // entries a pre-canonicalization writer recorded under a bare `resolve`
      // (the old worktree provisioner did exactly that) stay findable instead
      // of falling through to a hash of their realpath.
      const legacyDir = mkdtempSync(join(tmpdir(), "rc-legacy-"));
      const nonCanonical = join(legacyDir, "clone");
      mkdirSync(nonCanonical, { recursive: true });
      // Only meaningful where the temp root is symlinked (macOS /var); on a
      // platform where it is not, the two spellings coincide and the case
      // degenerates to the ordinary registered-path lookup.
      registry.record({
        collectionName: "code_legacy01",
        path: nonCanonical,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });

      const out = resolveCollection(registry, { path: nonCanonical });

      expect(out.collectionName).toBe("code_legacy01");
      expect(out.path).toBe(nonCanonical);
      rmSync(legacyDir, { recursive: true, force: true });
    });

    it("priority 3 fresh path: unregistered path falls back to md5-derived hash, deterministically", () => {
      const freshPath = "/unregistered/fresh/project";
      const first = resolveCollection(registry, { path: freshPath });
      const second = resolveCollection(registry, { path: freshPath });
      // Golden literal pins the EXACT `code_` + md5(absPath)[0:8] identity,
      // independent of resolveCollectionName. A self-referential compare
      // (both operands routed through the same hash fn) survives a
      // substring(0,8)->(0,7), offset, or algorithm mutation; the frozen
      // on-the-wire name does not.
      expect(first.collectionName).toBe("code_b6f31e23");
      expect(first.collectionName).toBe(resolveCollectionName(freshPath));
      expect(second.collectionName).toBe(first.collectionName);
    });
  });

  /**
   * The same path rule, packaged for collaborators that are handed a path and
   * no request — the drift reporter and the stamp/reset sites of an index run
   * (bd tea-rags-mcp-waj6k). What it must not do is derive a second rule: a
   * relocated project has to land on the collection a SEARCH resolves.
   */
  describe("createPathCollectionResolver", () => {
    let dir: string;
    let registry: CollectionRegistry;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "rc-path-"));
      registry = new CollectionRegistry(dir);
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("resolves a relocated project to the registry's collection, not a fresh hash", async () => {
      const movedPath = join(dir, "moved-here");
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

      const resolved = await createPathCollectionResolver(registry)(movedPath);

      expect(resolved).toBe("code_old12345");
      expect(resolved).not.toBe(resolveCollectionName(movedPath));
    });

    it("falls back to the path hash when nothing is registered for the path", async () => {
      expect(await createPathCollectionResolver(registry)("/unregistered/fresh/project")).toBe("code_b6f31e23");
    });

    it("matches a registry entry recorded under the path's realpath", async () => {
      // Entries store what `validatePath` returned at record time, so a caller
      // handing over the pre-realpath spelling (`/tmp/...` on macOS) must still
      // find the entry — otherwise the relocation defect returns by another name.
      const realDir = await validatePath(dir);
      registry.record({
        collectionName: "code_real1234",
        path: realDir,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "u",
        indexedAt: "t",
        teaRagsVersion: "v",
        chunksCount: 0,
      });

      expect(await createPathCollectionResolver(registry)(dir)).toBe("code_real1234");
    });
  });
});
