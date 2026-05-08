import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { IndexStatus } from "../../../src/core/api/public/dto/ingest.js";

function statusFixture(overrides: Partial<IndexStatus>): IndexStatus {
  return {
    isIndexed: false,
    status: "not_indexed",
    ...overrides,
  };
}

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

  describe("status section", () => {
    it("emits 'not indexed' message with /tea-rags:index hint", () => {
      const out = formatPrime({
        path: "/p",
        status: statusFixture({ status: "not_indexed" }),
        metrics: null,
        drift: null,
      });
      expect(out).toContain("## Status");
      expect(out).toContain("not indexed. Run `/tea-rags:index`");
    });

    it("emits 'stale indexing marker' message", () => {
      const out = formatPrime({
        path: "/p",
        status: statusFixture({ status: "stale_indexing" }),
        metrics: null,
        drift: null,
      });
      expect(out).toContain("stale indexing marker");
      expect(out).toContain("Re-run /tea-rags:index");
    });

    it("emits 'indexing in progress' with chunks count and skips metrics block", () => {
      const out = formatPrime({
        path: "/p",
        status: statusFixture({ status: "indexing", chunksCount: 412 }),
        metrics: null,
        drift: null,
      });
      expect(out).toContain("indexing in progress (412 chunks so far)");
      expect(out).not.toContain("## Polyglot");
      expect(out).not.toContain("## Signal thresholds");
    });

    it("emits indexed status line with chunks count and collection name", () => {
      const out = formatPrime({
        path: "/p",
        status: statusFixture({
          isIndexed: true,
          status: "indexed",
          collectionName: "code_27622aef",
          chunksCount: 4218,
        }),
        metrics: null,
        drift: null,
      });
      expect(out).toContain("indexed · collection `code_27622aef` · 4218 chunks");
    });
  });
});
