import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectNameInvalidError, ProjectNotRegisteredError } from "../../../../../src/core/api/errors.js";
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
  });
});
