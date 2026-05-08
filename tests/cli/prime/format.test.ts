import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";

describe("formatPrime", () => {
  describe("placeholder cases", () => {
    it("emits 'Path not found' when failure kind is path-not-found", () => {
      const out = formatPrime({ kind: "path-not-found", path: "/missing/dir" });
      expect(out).toBe("# tea-rags prime\nPath not found: /missing/dir\n");
    });

    it("emits 'warm-up pending' when failure kind is qdrant-cold", () => {
      const out = formatPrime({ kind: "qdrant-cold", path: "/some/project" });
      expect(out).toContain("# tea-rags prime");
      expect(out).toContain("Qdrant warm-up pending — index queries will be available after MCP server attaches.");
    });
  });
});
