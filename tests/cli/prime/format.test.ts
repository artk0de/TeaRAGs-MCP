import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { IndexStatus } from "../../../src/core/api/public/dto/ingest.js";
import type { IndexMetrics } from "../../../src/core/api/public/dto/metrics.js";

function statusFixture(overrides: Partial<IndexStatus>): IndexStatus {
  return {
    isIndexed: false,
    status: "not_indexed",
    ...overrides,
  };
}

function metricsFixture(): IndexMetrics {
  return {
    collection: "code_27622aef",
    totalChunks: 4218,
    totalFiles: 327,
    distributions: {
      language: { typescript: 3104, javascript: 612, markdown: 502 },
    },
    signals: {
      typescript: {
        "git.file.commitCount": {
          source: { min: 1, max: 41, count: 250, labelMap: { low: 2, normal: 5, high: 9, extreme: 9 } },
          test: { min: 1, max: 12, count: 60, labelMap: { low: 1, normal: 3, high: 6, extreme: 6 } },
        },
        "git.file.ageDays": {
          source: { min: 0, max: 600, count: 250, labelMap: { recent: 14, typical: 45, legacy: 45 } },
          test: { min: 0, max: 600, count: 60, labelMap: { recent: 14, typical: 45, legacy: 45 } },
        },
      },
    },
  };
}

function monolingualMetricsFixture(): IndexMetrics {
  const m = metricsFixture();
  m.distributions = { language: { typescript: 4218 } };
  return m;
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

describe("formatPrime — polyglot + thresholds", () => {
  it("emits Polyglot section with primary language (highest count) and others, sorted desc", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: metricsFixture(),
      drift: null,
    });
    expect(out).toContain("## Polyglot");
    expect(out).toContain("primary: typescript");
    expect(out).toContain("also: javascript, markdown");
    expect(out).toContain("for non-primary languages, call `get_index_metrics`");
  });

  it("emits Language section (not Polyglot) when distributions has only one language", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: monolingualMetricsFixture(),
      drift: null,
    });
    expect(out).toContain("## Language");
    expect(out).toContain("typescript");
    expect(out).not.toContain("## Polyglot");
  });

  it("emits Signal thresholds section with table for primary language", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: monolingualMetricsFixture(),
      drift: null,
    });
    expect(out).toContain("## Signal thresholds — typescript");
    expect(out).toContain("git.file.commitCount");
    expect(out).toContain("low ≤2 / normal ≤5 / high ≤9 / extreme >9");
  });

  it("omits Polyglot/Language and Signal thresholds when metrics is null (e.g. no enrichment yet)", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 4218,
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Status");
    expect(out).not.toContain("## Signal thresholds");
  });
});

describe("formatPrime — schema drift", () => {
  it("emits 'none' when drift is null", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 100,
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Schema drift");
    expect(out).toContain("none");
  });

  it("includes drift warning text when drift is non-null", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({
        isIndexed: true,
        status: "indexed",
        collectionName: "c",
        chunksCount: 100,
      }),
      metrics: null,
      drift: "New fields: navigation. Run index_codebase with forceReindex=true.",
    });
    expect(out).toContain("## Schema drift");
    expect(out).toContain("New fields: navigation");
    expect(out).toContain("Run index_codebase with forceReindex=true");
  });

  it("omits drift section when status is not 'indexed'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "not_indexed" }),
      metrics: null,
      drift: null,
    });
    expect(out).not.toContain("## Schema drift");
  });
});
