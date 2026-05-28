import { mkdtempSync, rmSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectionNotProvidedError, ProjectNotRegisteredError } from "../../../src/core/api/errors.js";
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
  });
});
