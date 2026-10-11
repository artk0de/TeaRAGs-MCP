import { realpath } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validatePath } from "../../../../src/core/adapters/filesystem/path-canonicalization.js";

describe("collection-name utilities", () => {
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
});
