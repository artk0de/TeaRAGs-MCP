import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/dto/ingest.js";
import type { IndexMetrics } from "../../../../src/core/api/public/dto/metrics.js";
import { formatSlimDigest } from "../../../../src/mcp/resources/project/digest.js";

const NOW = new Date("2026-05-11T12:00:00Z");

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
      totalFiles: 327,
      language: { typescript: 3104, javascript: 612, markdown: 502 },
      chunkType: {},
      documentation: { docs: 502, code: 3716 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
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

describe("formatSlimDigest", () => {
  describe("status section", () => {
    it("emits 'not indexed' message with /tea-rags:index hint", () => {
      const out = formatSlimDigest(
        {
          path: "/p",
          projectName: null,
          status: statusFixture({ status: "not_indexed" }),
          metrics: null,
          drift: null,
        },
        NOW,
      );
      expect(out).toContain("not indexed. Run `/tea-rags:index`");
    });

    it("emits 'stale indexing marker' message", () => {
      const out = formatSlimDigest(
        {
          path: "/p",
          projectName: null,
          status: statusFixture({ status: "stale_indexing" }),
          metrics: null,
          drift: null,
        },
        NOW,
      );
      expect(out).toContain("stale indexing marker");
      expect(out).toContain("Re-run /tea-rags:index");
    });

    it("emits 'indexing in progress' with chunks count and skips metrics block", () => {
      const out = formatSlimDigest(
        {
          path: "/p",
          projectName: null,
          status: statusFixture({ status: "indexing", chunksCount: 412 }),
          metrics: null,
          drift: null,
        },
        NOW,
      );
      expect(out).toContain("indexing in progress (412 chunks so far)");
      expect(out).not.toContain("## Polyglot");
      expect(out).not.toContain("## Signal thresholds");
    });

    it("emits indexed status line with chunks count and collection name", () => {
      const out = formatSlimDigest(
        {
          path: "/p",
          projectName: null,
          status: statusFixture({
            isIndexed: true,
            status: "indexed",
            collectionName: "code_27622aef",
            chunksCount: 4218,
          }),
          metrics: null,
          drift: null,
        },
        NOW,
      );
      expect(out).toContain("indexed · collection `code_27622aef` · 4218 chunks");
    });
  });
});

describe("formatSlimDigest — drift", () => {
  const baseData = {
    path: "/p",
    projectName: null,
    status: statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    }),
    metrics: null,
    drift: null,
  };

  it("emits 'none' when drift is null", () => {
    const out = formatSlimDigest(baseData, NOW);
    expect(out).toContain("## Drift");
    expect(out).toContain("none");
  });

  it("includes drift warning text when drift is non-null", () => {
    const out = formatSlimDigest(
      {
        ...baseData,
        drift: "New fields: navigation. Run index_codebase with forceReindex=true.",
      },
      NOW,
    );
    expect(out).toContain("## Drift");
    expect(out).toContain("New fields: navigation");
    expect(out).toContain("Run index_codebase with forceReindex=true");
  });

  it("omits drift section when status is not 'indexed'", () => {
    const out = formatSlimDigest({ ...baseData, status: statusFixture({ status: "not_indexed" }) }, NOW);
    expect(out).not.toContain("## Drift");
  });

  it("renders one ## Drift section with the report, or none", () => {
    const withDrift = formatSlimDigest(
      {
        ...baseData,
        drift:
          "Language versions:\n  python.walker: 1 → 3\nRun: tea-rags index-codebase --force-enrichments codegraph --languages python",
      },
      NOW,
    );
    expect(withDrift).toContain("## Drift\nLanguage versions:");
    expect(withDrift).toContain("Run: tea-rags index-codebase");
    expect(withDrift).not.toContain("## Schema drift");
    expect(withDrift).not.toContain("## Language versions");
    expect(formatSlimDigest({ ...baseData, drift: null }, NOW)).toContain("## Drift\nnone");
  });
});

describe("formatSlimDigest — staleness (lastUpdated)", () => {
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
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(lastUpdated), metrics: null, drift: null },
      NOW,
    );
    expect(out).toContain("last indexed: 2h ago");
  });

  it("renders 'last indexed: 5d ago' when lastUpdated is 5d before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(lastUpdated), metrics: null, drift: null },
      NOW,
    );
    expect(out).toContain("last indexed: 5d ago");
  });

  it("renders 'last indexed: 30m ago' when lastUpdated is 30 minutes before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 30 * 60 * 1000);
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(lastUpdated), metrics: null, drift: null },
      NOW,
    );
    expect(out).toContain("last indexed: 30m ago");
  });

  it("does NOT emit stale warning when lastUpdated is ≤24h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 23 * 60 * 60 * 1000);
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(lastUpdated), metrics: null, drift: null },
      NOW,
    );
    expect(out).not.toContain("Index is stale");
    expect(out).not.toContain("Run `index_codebase`");
  });

  it("emits stale warning recommending index_codebase when lastUpdated > 24h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(lastUpdated), metrics: null, drift: null },
      NOW,
    );
    expect(out).toContain("⚠ Index is stale (last updated 3d ago)");
    expect(out).toContain("Run `index_codebase` before the next tea-rags search/explore");
  });

  it("places stale warning AFTER Status block and BEFORE Drift", () => {
    const lastUpdated = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(lastUpdated), metrics: null, drift: null },
      NOW,
    );
    const warnIdx = out.indexOf("⚠ Index is stale");
    const driftIdx = out.indexOf("## Drift");
    expect(driftIdx).toBeGreaterThan(warnIdx);
  });

  it("omits 'last indexed' line entirely when lastUpdated is undefined", () => {
    const out = formatSlimDigest(
      { path: "/p", projectName: null, status: indexedFixture(undefined), metrics: null, drift: null },
      NOW,
    );
    expect(out).not.toContain("last indexed");
    expect(out).not.toContain("Index is stale");
  });
});

describe("formatSlimDigest — infra-health and enrichment", () => {
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
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus(),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).not.toContain("## Infra");
  });

  it("appends 'background optimization in progress' suffix when qdrant status is yellow", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus({
          infraHealth: {
            qdrant: { available: true, url: "http://127.0.0.1:63995", status: "yellow", optimizerStatus: "ok" },
            embedding: { available: true, provider: "ollama" },
          },
        }),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).toContain(
      "qdrant: yellow (optimizer ok) at http://127.0.0.1:63995 — background optimization in progress",
    );
  });

  it("appends 'UNAVAILABLE, search will fail' suffix when qdrant status is red", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus({
          infraHealth: {
            qdrant: { available: false, url: "http://127.0.0.1:63995", status: "red" },
            embedding: { available: true, provider: "ollama" },
          },
        }),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).toContain("qdrant: red");
    expect(out).toContain("— UNAVAILABLE, search will fail");
  });

  it("renders embedding as 'unavailable' when infraHealth.embedding.available is false", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus({
          infraHealth: {
            qdrant: { available: true, url: "x", status: "green", optimizerStatus: "ok" },
            embedding: { available: false, provider: "ollama", url: "http://localhost:11434" },
          },
        }),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).toContain("embedding: ollama · primary http://localhost:11434 (unavailable)");
  });

  it("omits ## Enrichment section when enrichment is undefined", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus(),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).not.toContain("## Enrichment");
  });

  it("appends '(in progress)' suffix when any sub-status is 'in_progress'", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
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
      },
      NOW,
    );
    expect(out).toContain("git: file healthy, chunk in_progress (in progress)");
  });
});

describe("formatSlimDigest — filesCount", () => {
  function indexedStatus(overrides: Partial<IndexStatus> = {}): IndexStatus {
    return statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
      ...overrides,
    });
  }

  it("renders filesCount alongside chunks when filesCount is present", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus({ filesCount: 327, chunksCount: 4218 }),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).toContain("indexed · collection `c` · 327 files / 4218 chunks");
  });

  it("falls back to chunks-only when filesCount is undefined", () => {
    const out = formatSlimDigest(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus({ filesCount: undefined, chunksCount: 4218 }),
        metrics: null,
        drift: null,
      },
      NOW,
    );
    expect(out).toContain("indexed · collection `c` · 4218 chunks");
    expect(out).not.toContain("files /");
  });
});

describe("formatSlimDigest — codegraph resolve (7m5xz)", () => {
  function indexed(overrides: Partial<IndexStatus> = {}): IndexStatus {
    return statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 1, ...overrides });
  }

  describe("default mode (no DEBUG) — plain rates and plain warnings", () => {
    type ResolveSummary = NonNullable<IndexStatus["codegraphResolve"]>;
    type ResolveLanguageRow = NonNullable<ResolveSummary["byLanguage"]>[number];

    const RUBY_WARNING =
      "⚠ ruby: 299 calls like `Service.call(...)` are linked to a shared base method, not the service itself — " +
      "get_callers on those services misses callers. Find usages with hybrid_search; persists after reindex → /tea-rags:report-issue";

    function summary(overrides: Partial<ResolveSummary>): ResolveSummary {
      return {
        inProjectEdgeRecall: 0.9,
        coveredRecall: 0.9,
        callsAttempted: 200,
        callsResolved: 180,
        callsExternalSkipped: 0,
        callsUnresolvable: 0,
        callsNoInProjectDef: 0,
        callsCoreAmbiguous: 0,
        ambiguousFanout: 0,
        callsUnnarrowedTemplate: 0,
        ...overrides,
      };
    }

    function languageRow(language: string, recall: number, unnarrowed: number): ResolveLanguageRow {
      return {
        language,
        inProjectEdgeRecall: recall,
        callsAttempted: 100,
        callsResolved: Math.round(recall * 100),
        callsExternalSkipped: 0,
        callsUnresolvable: 0,
        callsNoInProjectDef: 0,
        callsCoreAmbiguous: 0,
        callsUnnarrowedTemplate: unnarrowed,
      };
    }

    function multiLanguage(tsUnnarrowed: number, rubyUnnarrowed: number): ResolveSummary {
      return summary({
        inProjectEdgeRecall: 0.94,
        callsUnnarrowedTemplate: tsUnnarrowed + rubyUnnarrowed,
        byLanguage: [languageRow("typescript", 0.991, tsUnnarrowed), languageRow("ruby", 0.886, rubyUnnarrowed)],
      });
    }

    function render(codegraphResolve: ResolveSummary): string {
      return formatSlimDigest(
        {
          path: "/p",
          projectName: null,
          status: indexed({ codegraphResolve }),
          metrics: metricsFixture(),
          drift: null,
        },
        NOW,
      );
    }

    it("adds one plain warning line per language that carries unnarrowed entry calls", () => {
      const out = render(multiLanguage(0, 299));
      expect(out).not.toContain("⚠ typescript");
      expect(out.split("\n").filter((line) => line.startsWith("⚠ "))).toHaveLength(1);
    });

    it("warns for every carrying language, in byLanguage order", () => {
      const out = render(multiLanguage(12, 299));
      const warnings = out.split("\n").filter((line) => line.startsWith("⚠ "));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toMatch(/^⚠ typescript: 12 calls like `Service\.call\(\.\.\.\)`/);
      expect(warnings[1]).toBe(RUBY_WARNING);
    });

    it("renders no receiver-kind rows and no resolved/attempted counts, even when a breakdown is present", () => {
      const tally = multiLanguage(0, 299);
      const ruby = tally.byLanguage?.[1];
      if (ruby) {
        ruby.byReceiverKind = [
          {
            receiverKind: "constant",
            inProjectEdgeRecall: 0.89,
            coveredRecall: 0.89,
            attempted: 100,
            resolved: 89,
            externalSkipped: 0,
            unresolvable: 0,
            callsNoInProjectDef: 0,
            callsCoreAmbiguous: 0,
            ambiguousFanout: 0,
            callsUnnarrowedTemplate: 299,
            resolveSuccessRate: 0.89,
          },
        ];
      }
      const out = render(tally);
      expect(out).not.toContain("constant 0.");
      expect(out).not.toContain("89/100");
      expect(out).not.toContain("unnarrowed");
      expect(out).not.toContain("constant-receiver entry call(s)");
    });
  });
});
