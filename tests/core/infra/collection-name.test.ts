import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { resolveCollection, resolveCollectionName, validatePath } from "../../../src/core/infra/collection-name.js";

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

  describe("resolveCollection", () => {
    it("returns collection name when provided directly", () => {
      const result = resolveCollection("my_collection", undefined);
      expect(result.collectionName).toBe("my_collection");
      expect(result.path).toBeUndefined();
    });

    it("resolves collection name from path", () => {
      const result = resolveCollection(undefined, "/tmp/project");
      expect(result.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
      expect(result.path).toBe("/tmp/project");
    });

    it("prefers collection over path", () => {
      const result = resolveCollection("explicit", "/tmp/project");
      expect(result.collectionName).toBe("explicit");
    });

    it("throws CollectionRefError when neither provided", () => {
      expect(() => resolveCollection(undefined, undefined)).toThrow(/collection.*path/i);
    });
  });
});
