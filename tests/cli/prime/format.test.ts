import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import { available, unavailable, upToDate } from "../../../src/cli/update-check/types.js";
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
        update: null,
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
        update: null,
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
        update: null,
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
        update: null,
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
      update: null,
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
      update: null,
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
      update: null,
    });
    expect(out).toContain("## Signal thresholds — typescript");
    // Collapsed: one line per signal, source + test on the same line, exact
    // label names preserved (overlay labels must match the threshold keys).
    expect(out).toContain(
      "- **git.file.commitCount** — source: low ≤2 / normal ≤5 / high ≤9 / extreme >9 · test: low ≤1 / normal ≤3 / high ≤6 / extreme >6",
    );
    expect(out).not.toContain("  - source:");
    expect(out).not.toContain("  - test:");
  });

  it("renders thresholds for every language carrying per-language signals, each listed as primary", () => {
    // Per-language signal buckets exist only for code languages holding
    // >= MIN_LANGUAGE_SHARE of the chunks — a Rails + TS monolith qualifies both.
    const metrics = metricsFixture();
    metrics.distributions = { language: { ruby: 8200, typescript: 5000, markdown: 700, javascript: 40 } };
    metrics.signals["ruby"] = {
      "git.file.commitCount": {
        source: { min: 1, max: 30, count: 400, labelMap: { low: 1, normal: 2, high: 7, extreme: 7 } },
      },
    };
    metrics.signals["global"] = {
      "git.file.commitCount": { source: { min: 1, max: 41, count: 650, labelMap: { low: 1 } } },
    };
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 13940 }),
      metrics,
      drift: null,
      update: null,
    });

    expect(out).toContain("primary: ruby, typescript · also: markdown, javascript");
    const rubyAt = out.indexOf("## Signal thresholds — ruby");
    const typescriptAt = out.indexOf("## Signal thresholds — typescript");
    expect(rubyAt).toBeGreaterThan(-1);
    expect(typescriptAt).toBeGreaterThan(rubyAt);
    expect(out).toContain("- **git.file.commitCount** — source: low ≤1 / normal ≤2 / high ≤7 / extreme >7 · test: —");
    expect(out).not.toContain("## Signal thresholds — global");
    expect(out).not.toContain("## Signal thresholds — javascript");
  });

  it("collapses test bands to '=src' when test labelMap is identical to source (lossless)", () => {
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
      update: null,
    });
    // ageDays has identical source/test labelMaps in the fixture → back-ref, no repeat.
    expect(out).toContain("- **git.file.ageDays** — source: recent ≤14 / typical ≤45 / legacy ≤45 · test: =src");
  });

  it("renders percent-format signal bands as percentages (×100 with % suffix)", () => {
    const metrics = monolingualMetricsFixture();
    // pageRank-like normalized [0,1] signal: raw percentiles round to ≤0 on the
    // raw scale; with format:"percent" they render as readable percentages.
    metrics.signals["typescript"]["codegraph.chunk.pageRank"] = {
      source: {
        min: 0,
        max: 0.1,
        count: 250,
        labelMap: { peripheral: 0.00028, important: 0.00041, critical: 0.0012 },
        format: "percent",
      },
    };
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 4218 }),
      metrics,
      drift: null,
      update: null,
    });
    expect(out).toContain(
      "- **codegraph.chunk.pageRank** — source: peripheral ≤0.03% / important ≤0.04% / critical ≤0.12% · test: —",
    );
    // raw-scale rounding to ≤0 must NOT appear for this signal.
    expect(out).not.toContain("peripheral ≤0 /");
  });

  it("renders percent100-format signal bands with a % suffix and NO scaling", () => {
    const metrics = monolingualMetricsFixture();
    // bugFixRate is stored already on a 0–100 scale → suffix-only %, no ×100.
    metrics.signals["typescript"]["git.file.bugFixRate"] = {
      source: {
        min: 3,
        max: 83,
        count: 250,
        labelMap: { healthy: 25, concerning: 30, critical: 50 },
        format: "percent100",
      },
    };
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 4218 }),
      metrics,
      drift: null,
      update: null,
    });
    expect(out).toContain(
      "- **git.file.bugFixRate** — source: healthy ≤25% / concerning ≤30% / critical ≤50% · test: —",
    );
    // must NOT double-scale (×100 would yield ≤2500%).
    expect(out).not.toContain("≤2500%");
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
      update: null,
    });
    expect(out).toContain("## Status");
    expect(out).not.toContain("## Signal thresholds");
  });
});

describe("formatPrime — drift", () => {
  const NOW = new Date("2026-05-11T12:00:00Z");

  const baseData = {
    path: "/p",
    status: statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    }),
    metrics: null,
    drift: null,
    update: null,
  };

  it("emits 'none' when drift is null", () => {
    const out = formatPrime(baseData);
    expect(out).toContain("## Drift");
    expect(out).toContain("none");
  });

  it("includes drift warning text when drift is non-null", () => {
    const out = formatPrime({
      ...baseData,
      drift: "New fields: navigation. Run index_codebase with forceReindex=true.",
    });
    expect(out).toContain("## Drift");
    expect(out).toContain("New fields: navigation");
    expect(out).toContain("Run index_codebase with forceReindex=true");
  });

  it("omits drift section when status is not 'indexed'", () => {
    const out = formatPrime({ ...baseData, status: statusFixture({ status: "not_indexed" }) });
    expect(out).not.toContain("## Drift");
  });

  it("renders one ## Drift section with the report, or none", () => {
    const withDrift = formatPrime(
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
    expect(formatPrime({ ...baseData, drift: null }, NOW)).toContain("## Drift\nnone");
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
    const out = formatPrime(
      { path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null, update: null },
      NOW,
    );
    expect(out).toContain("last indexed: 2h ago");
  });

  it("renders 'last indexed: 5d ago' when lastUpdated is 5d before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000);
    const out = formatPrime(
      { path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null, update: null },
      NOW,
    );
    expect(out).toContain("last indexed: 5d ago");
  });

  it("renders 'last indexed: 30m ago' when lastUpdated is 30 minutes before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 30 * 60 * 1000);
    const out = formatPrime(
      { path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null, update: null },
      NOW,
    );
    expect(out).toContain("last indexed: 30m ago");
  });

  it("does NOT emit stale warning when lastUpdated is ≤24h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 23 * 60 * 60 * 1000);
    const out = formatPrime(
      { path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null, update: null },
      NOW,
    );
    expect(out).not.toContain("Index is stale");
    expect(out).not.toContain("Run `index_codebase`");
  });

  it("emits stale warning recommending index_codebase when lastUpdated > 24h before now", () => {
    const lastUpdated = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
    const out = formatPrime(
      { path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null, update: null },
      NOW,
    );
    expect(out).toContain("⚠ Index is stale (last updated 3d ago)");
    expect(out).toContain("Run `index_codebase` before the next tea-rags search/explore");
  });

  it("places stale warning AFTER Status block and BEFORE Drift", () => {
    const lastUpdated = new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1000);
    const out = formatPrime(
      { path: "/p", status: indexedFixture(lastUpdated), metrics: null, drift: null, update: null },
      NOW,
    );
    const statusIdx = out.indexOf("## Status");
    const warnIdx = out.indexOf("⚠ Index is stale");
    const driftIdx = out.indexOf("## Drift");
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThan(statusIdx);
    expect(driftIdx).toBeGreaterThan(warnIdx);
  });

  it("omits 'last indexed' line entirely when lastUpdated is undefined", () => {
    const out = formatPrime(
      { path: "/p", status: indexedFixture(undefined), metrics: null, drift: null, update: null },
      NOW,
    );
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
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: null, drift: null, update: null });
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
      update: null,
    });
    expect(out).toContain("## Infra");
    expect(out).toContain("qdrant: green (optimizer ok) at http://127.0.0.1:63995");
    expect(out).toContain("embedding: ollama · primary http://localhost:11434 (available)");
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
      update: null,
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
      update: null,
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
      update: null,
    });
    expect(out).toContain("embedding: ollama · primary http://localhost:11434 (unavailable)");
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
      update: null,
    });
    expect(out).toContain("embedding: available · onnx");
    expect(out).not.toContain("at undefined");
  });

  it("omits ## Enrichment section when enrichment is undefined", () => {
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: null, drift: null, update: null });
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
      update: null,
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
      update: null,
    });
    expect(out).toContain("git: file healthy, chunk in_progress (in progress)");
  });

  it("places ## Infra and ## Enrichment AFTER Drift, BEFORE Polyglot", () => {
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
      update: null,
    });
    const driftIdx = out.indexOf("## Drift");
    const infraIdx = out.indexOf("## Infra");
    const enrichIdx = out.indexOf("## Enrichment");
    const langIdx = out.indexOf("## Language");
    expect(driftIdx).toBeGreaterThanOrEqual(0);
    expect(infraIdx).toBeGreaterThan(driftIdx);
    expect(enrichIdx).toBeGreaterThan(infraIdx);
    expect(langIdx).toBeGreaterThan(enrichIdx);
  });
});

describe("formatPrime — filesCount and embeddingModel", () => {
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
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({ filesCount: 327, chunksCount: 4218 }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).toContain("indexed · collection `c` · 327 files / 4218 chunks");
  });

  it("falls back to chunks-only when filesCount is undefined", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({ filesCount: undefined, chunksCount: 4218 }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).toContain("indexed · collection `c` · 4218 chunks");
    expect(out).not.toContain("files /");
  });

  it("emits 'embedding: <model>' line below status when embeddingModel is set", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({ embeddingModel: "nomic-embed-text" }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).toContain("embedding: nomic-embed-text");
  });

  it("appends '· sparse v<N>' when sparseVersion is set", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({ embeddingModel: "nomic-embed-text", sparseVersion: 3 }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).toContain("embedding: nomic-embed-text · sparse v3");
  });

  it("omits the 'sparse v<N>' suffix when sparseVersion is undefined", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({ embeddingModel: "nomic-embed-text" }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).toContain("embedding: nomic-embed-text");
    expect(out).not.toContain("sparse v");
  });

  it("omits the embedding line entirely when embeddingModel is undefined", () => {
    const out = formatPrime({
      path: "/p",
      status: indexedStatus({ embeddingModel: undefined, sparseVersion: 3 }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).not.toMatch(/^embedding:/m);
  });
});

describe("formatPrime — polyglot whitelist + threshold rounding", () => {
  function indexedStatus(): IndexStatus {
    return statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
  }

  it("drops chunker artifacts (code, bash, text, gitignore, powershell, ts, yaml, json) from polyglot list", () => {
    const dirtyMetrics: IndexMetrics = {
      collection: "c",
      totalChunks: 1000,
      totalFiles: 100,
      distributions: {
        language: {
          typescript: 800,
          python: 100,
          code: 50,
          bash: 30,
          text: 10,
          gitignore: 5,
          powershell: 3,
          ts: 1,
          yaml: 1,
          json: 1,
        },
      },
      signals: {},
    };
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: dirtyMetrics, drift: null, update: null });
    expect(out).toContain("primary: typescript");
    expect(out).toContain("also: python");
    for (const artifact of ["code", "bash", "text", "gitignore", "powershell", "yaml", "json"]) {
      expect(out).not.toContain(`also: ${artifact}`);
      expect(out).not.toContain(`, ${artifact},`);
      expect(out).not.toContain(`, ${artifact}\n`);
    }
    // ts artifact (separate from typescript) — should also be dropped
    expect(out).not.toMatch(/, ts(,|\n|$)/);
  });

  it("rounds threshold values to 2 decimals (no IEEE float artifacts)", () => {
    const noisyMetrics: IndexMetrics = {
      collection: "c",
      totalChunks: 100,
      totalFiles: 10,
      distributions: { language: { typescript: 100 } },
      signals: {
        typescript: {
          "git.file.bugFixRate": {
            source: {
              min: 0,
              max: 100,
              count: 100,
              labelMap: { healthy: 25, concerning: 38, critical: 53.24999999999977 },
            },
          },
          "git.file.churnVolatility": {
            source: {
              min: 0,
              max: 100,
              count: 100,
              labelMap: { stable: 7.879999999999999, erratic: 14.010000000000002 },
            },
          },
        },
      },
    };
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: noisyMetrics, drift: null, update: null });
    expect(out).toContain("critical ≤53.25");
    expect(out).toContain("stable ≤7.88");
    expect(out).toContain("erratic ≤14.01");
    expect(out).not.toMatch(/\.\d{4,}/); // no four-or-more-decimal artifacts
  });
});

describe("formatPrime — refresh footer", () => {
  function indexedStatus(): IndexStatus {
    return statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
  }

  it("appends shell-command refresh hint at the end of an indexed digest", () => {
    const out = formatPrime({ path: "/p", status: indexedStatus(), metrics: null, drift: null, update: null });
    expect(out).toContain('→ run `tea-rags prime "$CLAUDE_PROJECT_DIR"` to refresh this digest after re-indexing');
    const lastLine = out
      .trimEnd()
      .split("\n")
      .filter((l) => l.length > 0)
      .pop();
    expect(lastLine).toContain("→ run `tea-rags prime");
  });

  it("does NOT append refresh hint when status is not 'indexed'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "not_indexed" }),
      metrics: null,
      drift: null,
      update: null,
    });
    expect(out).not.toContain('tea-rags prime "$CLAUDE_PROJECT_DIR"');
  });

  it("does NOT append refresh hint to placeholder failures", () => {
    const out = formatPrime({ kind: "qdrant-cold", path: "/p" });
    expect(out).not.toContain("refresh this digest");
  });
});

describe("formatPrime — tea-rags package section", () => {
  it("includes the `## tea-rags package` section when update.kind === 'available'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: available("1.23.1", "1.24.0"),
    });
    expect(out).toContain("## tea-rags package");
    expect(out).toContain("current:   1.23.1");
    expect(out).toContain("available: 1.24.0");
    expect(out).toContain("changelog: https://github.com/artk0de/TeaRAGs-MCP/releases/tag/v1.24.0");
  });

  it("omits the section when update.kind === 'up-to-date'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: upToDate("1.23.1"),
    });
    expect(out).not.toContain("## tea-rags package");
  });

  it("omits the section when update.kind === 'unavailable'", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: unavailable("timeout"),
    });
    expect(out).not.toContain("## tea-rags package");
  });

  it("omits the section when update is null", () => {
    const out = formatPrime({
      path: "/p",
      status: statusFixture({ status: "indexed", chunksCount: 1, collectionName: "c" }),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: null,
    });
    expect(out).not.toContain("## tea-rags package");
  });
});

describe("formatPrime — codegraph resolve (7m5xz)", () => {
  function indexed(overrides: Partial<IndexStatus> = {}): IndexStatus {
    return statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 1, ...overrides });
  }

  // The receiver-kind breakdown and the technical unnarrowed warning are a
  // developer measurement surface (`DEBUG=1 tea-rags prime`); these tests pin
  // that output under debug mode.
  const DEBUG = { debug: true };

  it("renders top-level byReceiverKind compactly, sorted by attempted desc", () => {
    const out = formatPrime(
      {
        path: "/p",
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.8,
            callsAttempted: 230,
            callsResolved: 185,
            callsExternalSkipped: 0,
            byReceiverKind: [
              {
                receiverKind: "selfMember",
                attempted: 130,
                resolved: 125,
                externalSkipped: 0,
                resolveSuccessRate: 125 / 130,
              },
              { receiverKind: "constant", attempted: 100, resolved: 60, externalSkipped: 0, resolveSuccessRate: 0.6 },
            ],
          },
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
        update: null,
      },
      undefined,
      DEBUG,
    );
    expect(out).toContain("## Codegraph resolve");
    expect(out).toContain("selfMember 0.96 125/130");
    expect(out).toContain("constant 0.6 60/100");
    expect(out.indexOf("selfMember")).toBeLessThan(out.indexOf("constant"));
  });

  // bd tea-rags-mcp-4vg1i — the aggregate warning says HOW MANY entry calls
  // stopped at a shared template; only the per-kind suffix says which bucket
  // carries them, which is what makes the number actionable (and what proves
  // the constant-receiver gate is holding, since every other kind must read 0).
  it("suffixes a receiver-kind row with its unnarrowed-entry count, and only when non-zero", () => {
    const out = formatPrime(
      {
        path: "/p",
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.7,
            callsAttempted: 200,
            callsResolved: 140,
            callsExternalSkipped: 0,
            callsUnnarrowedTemplate: 30,
            byReceiverKind: [
              {
                receiverKind: "constant",
                attempted: 120,
                resolved: 100,
                externalSkipped: 0,
                resolveSuccessRate: 100 / 120,
                callsUnnarrowedTemplate: 30,
              },
              {
                receiverKind: "bareCall",
                attempted: 80,
                resolved: 40,
                externalSkipped: 0,
                resolveSuccessRate: 0.5,
                callsUnnarrowedTemplate: 0,
              },
            ],
          },
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
        update: null,
      },
      undefined,
      DEBUG,
    );
    expect(out).toContain("constant 0.83 100/120 · 30 unnarrowed");
    expect(out).toContain("bareCall 0.5 40/80");
    expect(out).not.toContain("bareCall 0.5 40/80 · 0 unnarrowed");
    expect(out).toContain("⚠ 30 constant-receiver entry call(s)");
  });

  it("renders byReceiverKind nested under each language in the multi-language case", () => {
    const out = formatPrime(
      {
        path: "/p",
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.7,
            callsAttempted: 310,
            callsResolved: 245,
            callsExternalSkipped: 0,
            byLanguage: [
              {
                language: "typescript",
                resolveSuccessRate: 0.82,
                callsAttempted: 230,
                callsResolved: 185,
                callsExternalSkipped: 0,
                byReceiverKind: [
                  {
                    receiverKind: "selfMember",
                    attempted: 130,
                    resolved: 125,
                    externalSkipped: 0,
                    resolveSuccessRate: 125 / 130,
                  },
                ],
              },
              {
                language: "ruby",
                resolveSuccessRate: 0.75,
                callsAttempted: 80,
                callsResolved: 60,
                callsExternalSkipped: 0,
                byReceiverKind: [
                  {
                    receiverKind: "constant",
                    attempted: 80,
                    resolved: 60,
                    externalSkipped: 0,
                    resolveSuccessRate: 0.75,
                  },
                ],
              },
            ],
          },
        }),
        metrics: metricsFixture(),
        drift: null,
        update: null,
      },
      undefined,
      DEBUG,
    );
    expect(out).toContain("## Codegraph resolve");
    expect(out).toContain("typescript");
    expect(out).toContain("selfMember 0.96 125/130");
    expect(out).toContain("ruby");
    expect(out).toContain("constant 0.75 60/80");
  });

  it("omits the Codegraph resolve section when codegraphResolve is absent", () => {
    const out = formatPrime({
      path: "/p",
      status: indexed(),
      metrics: monolingualMetricsFixture(),
      drift: null,
      update: null,
    });
    expect(out).not.toContain("## Codegraph resolve");
  });

  // Default-mode fixtures mirror what summarizeCodegraphResolve emits WITHOUT
  // DEBUG: inProjectEdgeRecall is always present, while resolveSuccessRate and
  // every byReceiverKind breakdown are DEBUG-only and therefore absent.
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
      return formatPrime({
        path: "/p",
        status: indexed({ codegraphResolve }),
        metrics: metricsFixture(),
        drift: null,
        update: null,
      });
    }

    // No receiver-kind breakdown and no unnarrowed calls — exactly the healthy
    // non-DEBUG DTO. The debug-mode gate would omit the section here.
    it("renders one resolve-rate line, languages in byLanguage order, rounded", () => {
      const out = render(multiLanguage(0, 0));
      expect(out).toContain("## Codegraph resolve\nresolve rate: typescript 0.99 · ruby 0.89\n\n");
    });

    it("renders the top-level rate when there is no per-language breakdown", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.957 }));
      expect(out).toContain("## Codegraph resolve\nresolve rate: 0.96\n\n");
    });

    // resolveSuccessRate is DEBUG-only on the producer side, so the default
    // line must read the always-present recall.
    it("reads inProjectEdgeRecall, not the DEBUG-only resolveSuccessRate", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.957, resolveSuccessRate: 0.5 }));
      expect(out).toContain("resolve rate: 0.96");
      expect(out).not.toContain("resolve rate: 0.5");
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

    it("adds one plain warning line per language that carries unnarrowed entry calls", () => {
      const out = render(multiLanguage(0, 299));
      expect(out).toContain(`resolve rate: typescript 0.99 · ruby 0.89\n${RUBY_WARNING}\n`);
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

    it("falls back to the top-level count, without a language prefix, when there is no per-language breakdown", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.9, callsUnnarrowedTemplate: 299 }));
      expect(out).toContain(
        "resolve rate: 0.9\n⚠ 299 calls like `Service.call(...)` are linked to a shared base method, not the service itself — " +
          "get_callers on those services misses callers. Find usages with hybrid_search; persists after reindex → /tea-rags:report-issue\n",
      );
    });

    it("renders no warning when every unnarrowed count is zero", () => {
      const out = render(multiLanguage(0, 0));
      expect(out).not.toContain("⚠");
    });
  });
});
