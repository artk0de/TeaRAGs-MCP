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

describe("formatPrime — staleness (lastUpdated)", () => {
  const NOW = new Date("2026-05-11T12:00:00Z");

  function indexedFixture(lastUpdated?: Date): IndexStatus {
    return statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
      lastUpdated,
    });
  }

  it("renders 'last indexed: 2h ago' when lastUpdated is 2h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const out = formatPrime({ path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null }, NOW);
    expect(out).toContain("last indexed: 2h ago");
  });

  it("renders 'last indexed: 5d ago' when lastUpdated is 5d before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    const out = formatPrime({ path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null }, NOW);
    expect(out).toContain("last indexed: 5d ago");
  });

  it("renders 'last indexed: 30m ago' when lastUpdated is 30 minutes before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 30 * 60 * 1000);
    const out = formatPrime({ path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null }, NOW);
    expect(out).toContain("last indexed: 30m ago");
  });

  it("does NOT emit stale warning when lastUpdated is ≤24h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 23 * 60 * 60 * 1000);
    const out = formatPrime({ path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null }, NOW);
    expect(out).not.toContain("Index is stale");
    expect(out).not.toContain("Run `index_codebase`");
  });

  it("emits stale warning recommending index_codebase when lastUpdated > 24h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const out = formatPrime({ path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null }, NOW);
    expect(out).toContain("⚠ Index is stale (last updated 3d ago)");
    expect(out).toContain("Run `index_codebase` before the next tea-rags search/explore");
  });

  it("places stale warning AFTER Status block and BEFORE Schema drift", () => {
    const lastUpdated = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const out = formatPrime({ path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null }, NOW);
    const statusIdx = out.indexOf("## Status");
    const warnIdx = out.indexOf("⚠ Index is stale");
    const driftIdx = out.indexOf("## Schema drift");
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(statusIdx);
    expect(driftIdx).toBeGreaterThan(warnIdx);
  });

  it("omits 'last indexed' line entirely when lastUpdated is undefined", () => {
    const out = formatPrime({ path: "/p", status: indexedFixture(undefined), metrics: null, drift: null }, NOW);
    expect(out).not.toContain("last indexed");
    expect(out).not.toContain("Index is stale");
  });
});

describe("formatPrime — infra-health and enrichment", () => {
  function indexedStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
    return statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
      ...overrides,
    });
  }

  it("omits ## Infra section when infraHealth is undefined", () => {
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: null, drift: null });
    expect(out).not.toContain("## Infra");
  });

  it("emits ## Infra with qdrant + embedding lines when infraHealth is present", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        infraHealth: {
          qdrant: { available: true, url: "http://127.0.0.1:63995", status: "green", optimizerStatus: "ok" },
          embedding: { available: true, provider: "ollama", url: "http://localhost:11434" },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Infra");
    expect(out).toContain("qdrant: green (optimizer ok) at http://127.0.0.1:63995");
    expect(out).toContain("embedding: available · ollama at http://localhost:11434");
  });

  it("appends 'background optimization in progress' suffix when qdrant status is yellow", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        infraHealth: {
          qdrant: { available: true, url: "http://127.0.0.1:63995", status: "yellow", optimizerStatus: "ok" },
          embedding: { available: true, provider: "ollama" },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain(
      "qdrant: yellow (optimizer ok) at http://127.0.0.1:63995 — background optimization in progress",
    );
  });

  it("appends 'UNAVAILABLE, search will fail' suffix when qdrant status is red", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        infraHealth: {
          qdrant: { available: false, url: "http://127.0.0.1:63995", status: "red" },
          embedding: { available: true, provider: "ollama" },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("qdrant: red");
    expect(out).toContain("— UNAVAILABLE, search will fail");
  });

  it("renders embedding as 'unavailable' when infraHealth.embedding.available is false", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        infraHealth: {
          qdrant: { available: true, url: "x", status: "green", optimizerStatus: "ok" },
          embedding: { available: false, provider: "ollama", url: "http://localhost:11434" },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("embedding: unavailable · ollama at http://localhost:11434");
  });

  it("omits embedding url when undefined", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        infraHealth: {
          qdrant: { available: true, url: "x", status: "green", optimizerStatus: "ok" },
          embedding: { available: true, provider: "onnx" },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("embedding: available · onnx");
    expect(out).not.toContain("at undefined");
  });

  it("omits ## Enrichment section when enrichment is undefined", () => {
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: null, drift: null });
    expect(out).not.toContain("## Enrichment");
  });

  it("emits ## Enrichment with per-provider file/chunk status", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        enrichment: {
          git: {
            file: { status: "healthy" },
            chunk: { status: "healthy" },
          },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("## Enrichment");
    expect(out).toContain("git: file healthy, chunk healthy");
  });

  it("appends '(in progress)' suffix when any sub-status is 'in_progress'", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        enrichment: {
          git: {
            file: { status: "healthy" },
            chunk: { status: "in_progress" },
          },
        },
      }),
      metrics: null,
      drift: null,
    });
    expect(out).toContain("git: file healthy, chunk in_progress (in progress)");
  });

  it("places ## Infra and ## Enrichment AFTER Schema drift, BEFORE Polyglot", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({
        infraHealth: {
          qdrant: { available: true, url: "x", status: "green", optimizerStatus: "ok" },
          embedding: { available: true, provider: "ollama" },
        },
        enrichment: {
          git: { file: { status: "healthy" }, chunk: { status: "healthy" } },
        },
      }),
      metrics: monolingualMetricsFixture(),
      drift: null,
    });
    const driftIdx = out.indexOf("## Schema drift");
    const infraIdx = out.indexOf("## Infra");
    const enrichIdx = out.indexOf("## Enrichment");
    const langIdx = out.indexOf("## Language");
    expect(driftIdx).toBeGreaterThanOrEqual(0);
    expect(infraIdx).toBeGreaterThan(driftIdx);
    expect(enrichIdx).toBeGreaterThan(infraIdx);
    expect(langIdx).toBeGreaterThan(enrichIdx);
  });
});
