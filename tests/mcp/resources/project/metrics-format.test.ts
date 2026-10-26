import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/dto/ingest.js";
import type { IndexMetrics } from "../../../../src/core/api/public/dto/metrics.js";
import { formatProjectMetrics } from "../../../../src/mcp/resources/project/metrics.js";

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

function monolingualMetricsFixture(): IndexMetrics {
  const m = metricsFixture();
  m.distributions = {
    totalFiles: 4218,
    language: { typescript: 4218 },
    chunkType: {},
    documentation: { docs: 0, code: 4218 },
    topAuthors: [],
    topBlameAuthors: [],
    othersCount: 0,
  };
  return m;
}

describe("formatProjectMetrics — polyglot + thresholds", () => {
  it("emits Signal thresholds section with table for primary language", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 4218,
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).toContain("## Signal thresholds — typescript");
    // One table row per signal: exact label names once (overlay labels must
    // match them), then the lower bounds of the 2nd band on, source and test.
    expect(out).toContain("| git.file.commitCount | low/normal/high/extreme | 5 / 9 / 9 | 3 / 6 / 6 |");
    expect(out).not.toContain("  - source:");
    expect(out).toContain("lower bound of each band from the 2nd on (1st band = below the 2nd)");
    expect(out).not.toContain("  - test:");
  });

  it("renders thresholds for every language carrying per-language signals, each listed as primary", () => {
    // Per-language signal buckets exist only for code languages holding
    // >= MIN_LANGUAGE_SHARE of the chunks — a Rails + TS monolith qualifies both.
    const metrics = metricsFixture();
    metrics.distributions = {
      totalFiles: 13940,
      language: { ruby: 8200, typescript: 5000, markdown: 700, javascript: 40 },
      chunkType: {},
      documentation: { docs: 700, code: 13240 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    };
    metrics.signals["ruby"] = {
      "git.file.commitCount": {
        source: { min: 1, max: 30, count: 400, labelMap: { low: 1, normal: 2, high: 7, extreme: 7 } },
      },
    };
    metrics.signals["global"] = {
      "git.file.commitCount": { source: { min: 1, max: 41, count: 650, labelMap: { low: 1 } } },
    };
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 13940 }),
        metrics,
        drift: null,
      },
      {},
    );

    const rubyAt = out.indexOf("## Signal thresholds — ruby");
    const typescriptAt = out.indexOf("## Signal thresholds — typescript");
    expect(rubyAt).toBeGreaterThan(-1);
    expect(typescriptAt).toBeGreaterThan(rubyAt);
    expect(out).toContain("| git.file.commitCount | low/normal/high/extreme | 2 / 7 / 7 | — |");
    expect(out).not.toContain("## Signal thresholds — global");
    expect(out).not.toContain("## Signal thresholds — javascript");
  });

  it("collapses test bands to '=src' when test labelMap is identical to source (lossless)", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 4218,
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    // ageDays has identical source/test labelMaps in the fixture → back-ref, no repeat.
    expect(out).toContain("| git.file.ageDays | recent/typical/legacy | 45 / 45 | =src |");
  });

  it("renders percent-format signal bands as percentages (×100 with % suffix)", () => {
    const metrics = monolingualMetricsFixture();
    // pageRank-like normalized [0,1] signal: raw percentiles round to 0 on the
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
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 4218 }),
        metrics,
        drift: null,
      },
      {},
    );
    expect(out).toContain("| codegraph.chunk.pageRank | peripheral/important/critical | 0.04% / 0.12% | — |");
    // raw-scale rounding to 0 must NOT appear for this signal.
    expect(out).not.toContain("peripheral <0 /");
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
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 4218 }),
        metrics,
        drift: null,
      },
      {},
    );
    expect(out).toContain("| git.file.bugFixRate | healthy/concerning/critical | 30% / 50% | — |");
    // must NOT double-scale (×100 would yield 2500%).
    expect(out).not.toContain("2500%");
  });

  /**
   * A band's threshold is the LOWEST value that reaches it, not the highest it
   * admits: `resolveLabel` keeps the last band whose threshold the value has
   * reached. Rendering `label ≤threshold` inverted every band in the digest —
   * `healthy ≤0%` read as "healthy only at exactly 0%" when it actually meant
   * "healthy below the next band". The first band is the below-everything
   * default, so it is the only one with an upper bound to show.
   */
  it("renders a band by the values it actually owns, not by its own lower bound", () => {
    const metrics = monolingualMetricsFixture();
    metrics.signals["typescript"]["git.chunk.bugFixRate"] = {
      source: {
        min: 0,
        max: 100,
        count: 9051,
        labelMap: { healthy: 0, concerning: 50, critical: 100 },
        format: "percent100",
      },
    };
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 4218 }),
        metrics,
        drift: null,
      },
      {},
    );

    expect(out).toContain("| git.chunk.bugFixRate | healthy/concerning/critical | 50% / 100% | — |");
    // The inverted form must be gone: it claimed `healthy` admitted only 0%.
    expect(out).not.toContain("healthy ≤0%");
  });

  it("renders a lone band without a bound — it catches every value", () => {
    const metrics = monolingualMetricsFixture();
    metrics.signals["typescript"] = {
      "git.file.commitCount": { source: { min: 1, max: 41, count: 250, labelMap: { low: 3 } } },
    };
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 4218 }),
        metrics,
        drift: null,
      },
      {},
    );

    expect(out).toContain("| git.file.commitCount | low | any | — |");
  });

  it("omits Polyglot/Language and Signal thresholds when metrics is null (e.g. no enrichment yet)", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: statusFixture({
          isIndexed: true,
          status: "indexed",
          collectionName: "c",
          chunksCount: 4218,
        }),
        metrics: null,
        drift: null,
      },
      {},
    );
    expect(out).not.toContain("## Signal thresholds");
  });
});

describe("formatProjectMetrics — polyglot whitelist + threshold rounding", () => {
  function indexedStatus(): IndexStatus {
    return statusFixture({
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
    });
  }

  it("rounds threshold values to 2 decimals (no IEEE float artifacts)", () => {
    const noisyMetrics: IndexMetrics = {
      collection: "c",
      totalChunks: 100,
      totalFiles: 10,
      distributions: {
        totalFiles: 100,
        language: { typescript: 100 },
        chunkType: {},
        documentation: { docs: 0, code: 100 },
        topAuthors: [],
        topBlameAuthors: [],
        othersCount: 0,
      },
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
              // Three bands, so the rounded 7.88 lands on a band that carries
              // its own lower bound — the FIRST band renders its successor's
              // threshold, never its own.
              labelMap: { calm: 1.5, stable: 7.879999999999999, erratic: 14.010000000000002 },
            },
          },
        },
      },
    };
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexedStatus(),
        metrics: noisyMetrics,
        drift: null,
      },
      {},
    );
    expect(out).toContain("| git.file.bugFixRate | healthy/concerning/critical | 38 / 53.25 | — |");
    expect(out).toContain("| git.file.churnVolatility | calm/stable/erratic | 7.88 / 14.01 | — |");
    expect(out).not.toMatch(/\.\d{4,}/); // no four-or-more-decimal artifacts
  });
});

describe("formatProjectMetrics — codegraph resolve (7m5xz)", () => {
  function indexed(overrides: Partial<IndexStatus> = {}): IndexStatus {
    return statusFixture({ isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 1, ...overrides });
  }

  it("renders top-level byReceiverKind compactly, sorted by attempted desc", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.8,
            inProjectEdgeRecall: 185 / 230,
            coveredRecall: 185 / 230,
            callsUnresolvable: 0,
            callsNoInProjectDef: 0,
            callsCoreAmbiguous: 0,
            ambiguousFanout: 0,
            callsUnnarrowedTemplate: 0,
            callsAttempted: 230,
            callsResolved: 185,
            callsExternalSkipped: 0,
            byReceiverKind: [
              {
                receiverKind: "selfMember",
                inProjectEdgeRecall: 125 / 130,
                coveredRecall: 125 / 130,
                attempted: 130,
                resolved: 125,
                externalSkipped: 0,
                unresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: 125 / 130,
              },
              {
                receiverKind: "constant",
                inProjectEdgeRecall: 0.6,
                coveredRecall: 0.6,
                attempted: 100,
                resolved: 60,
                externalSkipped: 0,
                unresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: 0.6,
              },
            ],
          },
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).toContain("## Codegraph resolve");
    expect(out).toContain("selfMember 0.96 125/130");
    expect(out).toContain("constant 0.6 60/100");
    expect(out.indexOf("selfMember")).toBeLessThan(out.indexOf("constant"));
  });

  // bd tea-rags-mcp-2m83f.38 — a bucket a model raised says by how many sites.
  it("appends the model's sites to a receiver-kind line a model raised", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.85,
            inProjectEdgeRecall: 0.85,
            coveredRecall: 0.85,
            staticInProjectEdgeRecall: 0.848,
            callsResolvedByModel: 81,
            modelResolution: [{ model: "kev", threshold: 0.7, sites: 81 }],
            callsUnresolvable: 0,
            callsNoInProjectDef: 0,
            callsCoreAmbiguous: 0,
            ambiguousFanout: 0,
            callsUnnarrowedTemplate: 0,
            callsAttempted: 61151,
            callsResolved: 34179,
            callsExternalSkipped: 20940,
            byReceiverKind: [
              {
                receiverKind: "dynamic",
                inProjectEdgeRecall: 0.85,
                coveredRecall: 0.85,
                staticInProjectEdgeRecall: 0.848,
                attempted: 61151,
                resolved: 34179,
                resolvedByModel: 81,
                externalSkipped: 20940,
                unresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: 0.85,
              },
            ],
          },
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).toContain("dynamic 0.85 34179/61151 (model +81)");
  });

  // bd tea-rags-mcp-qodqg — a kind whose every site was excluded (here: no
  // in-project def) has an empty rate denominator. summarizeCodegraphResolve
  // reports its rate as null; the row must say "nothing to score", never a
  // number, with the counters kept.
  it("renders a receiver-kind row with an empty rate denominator as the marker, not a rate", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.96,
            inProjectEdgeRecall: 125 / 136,
            coveredRecall: 125 / 136,
            callsUnresolvable: 0,
            callsNoInProjectDef: 6,
            callsCoreAmbiguous: 0,
            ambiguousFanout: 0,
            callsUnnarrowedTemplate: 0,
            callsAttempted: 136,
            callsResolved: 125,
            callsExternalSkipped: 0,
            byReceiverKind: [
              {
                receiverKind: "selfMember",
                inProjectEdgeRecall: 125 / 130,
                coveredRecall: 125 / 130,
                attempted: 130,
                resolved: 125,
                externalSkipped: 0,
                unresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: 125 / 130,
              },
              {
                receiverKind: "index",
                inProjectEdgeRecall: null,
                coveredRecall: null,
                attempted: 6,
                resolved: 0,
                externalSkipped: 0,
                unresolvable: 0,
                callsNoInProjectDef: 6,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: null,
              },
            ],
          },
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).toContain("index —  0/6");
    expect(out).not.toContain("index 0 0/6");
    expect(out).toContain("selfMember 0.96 125/130");
  });

  // bd tea-rags-mcp-4vg1i — the aggregate warning says HOW MANY entry calls
  // stopped at a shared template; only the per-kind suffix says which bucket
  // carries them, which is what makes the number actionable (and what proves
  // the constant-receiver gate is holding, since every other kind must read 0).
  it("suffixes a receiver-kind row with its unnarrowed-entry count, and only when non-zero", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.7,
            inProjectEdgeRecall: 140 / 200,
            coveredRecall: 140 / 200,
            callsUnresolvable: 0,
            callsNoInProjectDef: 0,
            callsCoreAmbiguous: 0,
            ambiguousFanout: 0,
            callsUnnarrowedTemplate: 30,
            callsAttempted: 200,
            callsResolved: 140,
            callsExternalSkipped: 0,
            byReceiverKind: [
              {
                receiverKind: "constant",
                inProjectEdgeRecall: 100 / 120,
                coveredRecall: 100 / 120,
                attempted: 120,
                resolved: 100,
                externalSkipped: 0,
                unresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                resolveSuccessRate: 100 / 120,
                callsUnnarrowedTemplate: 30,
              },
              {
                receiverKind: "bareCall",
                inProjectEdgeRecall: 0.5,
                coveredRecall: 0.5,
                attempted: 80,
                resolved: 40,
                externalSkipped: 0,
                unresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                ambiguousFanout: 0,
                resolveSuccessRate: 0.5,
                callsUnnarrowedTemplate: 0,
              },
            ],
          },
        }),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).toContain("constant 0.83 100/120 · 30 unnarrowed");
    expect(out).toContain("bareCall 0.5 40/80");
    expect(out).not.toContain("bareCall 0.5 40/80 · 0 unnarrowed");
    expect(out).toContain("⚠ 30 constant-receiver entry call(s)");
  });

  it("renders byReceiverKind nested under each language in the multi-language case", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexed({
          codegraphResolve: {
            resolveSuccessRate: 0.7,
            inProjectEdgeRecall: 245 / 310,
            coveredRecall: 245 / 310,
            callsUnresolvable: 0,
            callsNoInProjectDef: 0,
            callsCoreAmbiguous: 0,
            ambiguousFanout: 0,
            callsUnnarrowedTemplate: 0,
            callsAttempted: 310,
            callsResolved: 245,
            callsExternalSkipped: 0,
            byLanguage: [
              {
                language: "typescript",
                inProjectEdgeRecall: 185 / 230,
                callsUnresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: 0.82,
                callsAttempted: 230,
                callsResolved: 185,
                callsExternalSkipped: 0,
                byReceiverKind: [
                  {
                    receiverKind: "selfMember",
                    inProjectEdgeRecall: 125 / 130,
                    coveredRecall: 125 / 130,
                    attempted: 130,
                    resolved: 125,
                    externalSkipped: 0,
                    unresolvable: 0,
                    callsNoInProjectDef: 0,
                    callsCoreAmbiguous: 0,
                    ambiguousFanout: 0,
                    callsUnnarrowedTemplate: 0,
                    resolveSuccessRate: 125 / 130,
                  },
                ],
              },
              {
                language: "ruby",
                inProjectEdgeRecall: 0.75,
                callsUnresolvable: 0,
                callsNoInProjectDef: 0,
                callsCoreAmbiguous: 0,
                callsUnnarrowedTemplate: 0,
                resolveSuccessRate: 0.75,
                callsAttempted: 80,
                callsResolved: 60,
                callsExternalSkipped: 0,
                byReceiverKind: [
                  {
                    receiverKind: "constant",
                    inProjectEdgeRecall: 0.75,
                    coveredRecall: 0.75,
                    attempted: 80,
                    resolved: 60,
                    externalSkipped: 0,
                    unresolvable: 0,
                    callsNoInProjectDef: 0,
                    callsCoreAmbiguous: 0,
                    ambiguousFanout: 0,
                    callsUnnarrowedTemplate: 0,
                    resolveSuccessRate: 0.75,
                  },
                ],
              },
            ],
          },
        }),
        metrics: metricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).toContain("## Codegraph resolve");
    expect(out).toContain("typescript");
    expect(out).toContain("selfMember 0.96 125/130");
    expect(out).toContain("ruby");
    expect(out).toContain("constant 0.75 60/80");
  });

  it("omits the Codegraph resolve section when codegraphResolve is absent", () => {
    const out = formatProjectMetrics(
      {
        path: "/p",
        projectName: null,
        status: indexed(),
        metrics: monolingualMetricsFixture(),
        drift: null,
      },
      {},
    );
    expect(out).not.toContain("## Codegraph resolve");
  });

  // Default-mode fixtures mirror what summarizeCodegraphResolve emits WITHOUT
  // DEBUG: inProjectEdgeRecall is always present, while resolveSuccessRate and
  // every byReceiverKind breakdown are DEBUG-only and therefore absent.
  describe("default mode (no DEBUG) — plain rates and plain warnings", () => {
    type ResolveSummary = NonNullable<IndexStatus["codegraphResolve"]>;
    type ResolveLanguageRow = NonNullable<ResolveSummary["byLanguage"]>[number];

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
      return formatProjectMetrics(
        {
          path: "/p",
          projectName: null,
          status: indexed({ codegraphResolve }),
          metrics: metricsFixture(),
          drift: null,
        },
        {},
      );
    }

    // No receiver-kind breakdown and no unnarrowed calls — exactly the healthy
    // non-DEBUG DTO. The debug-mode gate would omit the section here.
    it("renders one resolve-rate line, languages in byLanguage order, rounded", () => {
      const out = render(multiLanguage(0, 0));
      expect(out).toContain("## Codegraph resolve\nresolve rate: typescript 0.99 · ruby 0.89\n");
    });

    it("renders the top-level rate when there is no per-language breakdown", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.957 }));
      expect(out).toContain("## Codegraph resolve\nresolve rate: 0.96\n");
    });

    // bd tea-rags-mcp-stpvj — the default line is shown without DEBUG, so a
    // null (nothing scored) recall must render the marker, never "0".
    it("renders the empty-denominator marker for a null recall, top-level and per language", () => {
      expect(render(summary({ inProjectEdgeRecall: null }))).toContain("## Codegraph resolve\nresolve rate: —\n");
      const tally = multiLanguage(0, 0);
      const ruby = tally.byLanguage?.[1];
      if (ruby) ruby.inProjectEdgeRecall = null;
      expect(render(tally)).toContain("resolve rate: typescript 0.99 · ruby —\n");
    });

    it("keeps a scored zero recall as 0 in the default line", () => {
      expect(render(summary({ inProjectEdgeRecall: 0 }))).toContain("resolve rate: 0\n");
    });

    // resolveSuccessRate is DEBUG-only on the producer side, so the default
    // line must read the always-present recall.
    it("reads inProjectEdgeRecall, not the DEBUG-only resolveSuccessRate", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.957, resolveSuccessRate: 0.5 }));
      expect(out).toContain("resolve rate: 0.96");
      expect(out).not.toContain("resolve rate: 0.5");
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

    // bd tea-rags-mcp-2m83f.43 — residual sites receiver narrowing settled statically.
    it("renders the narrowed line when a run narrowed residual sites", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.9, callsNarrowed: 138, callsNarrowEmpty: 12 }));
      expect(out).toContain(
        "resolve rate: 0.9\nnarrowed: 138 residual calls settled by their receiver's other calls, 12 matched no class\n",
      );
    });

    // bd tea-rags-mcp-2m83f.49 — calls resolved on a parameter its callers typed.
    it("renders the paramTyped line when calls resolved on caller-typed parameters", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.9, callsParamTyped: 42 }));
      expect(out).toContain("resolve rate: 0.9\nparamTyped: 42 calls resolved on a parameter typed by its callers\n");
    });

    // bd tea-rags-mcp-2m83f.55 — residual sites whose callee is a schema column accessor.
    it("renders the schemaAttribute line when residual sites read a schema column", () => {
      const out = render(summary({ inProjectEdgeRecall: 0.9, callsSchemaAttribute: 31 }));
      expect(out).toContain(
        "resolve rate: 0.9\nschemaAttribute: 31 residual calls read a schema column (no in-project def)\n",
      );
    });

    it("renders no narrowed line before any site was narrowed", () => {
      expect(render(summary({ inProjectEdgeRecall: 0.9 }))).not.toContain("narrowed:");
    });

    // bd tea-rags-mcp-2m83f.38 — model-resolved sites: combined rate, static floor beside it.
    it("renders the static share and the model's sites beside a per-language rate", () => {
      const tally = multiLanguage(0, 0);
      tally.modelResolution = [{ model: "kev", threshold: 0.7, sites: 117 }];
      tally.byLanguage![1] = {
        ...tally.byLanguage![1],
        inProjectEdgeRecall: 0.921,
        staticInProjectEdgeRecall: 0.913,
        callsResolvedByModel: 117,
      };

      expect(render(tally)).toContain(
        "resolve rate: typescript 0.99 · ruby 0.92 (static 0.91 · model 117 sites, kev p>=0.7)\n",
      );
    });

    // bd tea-rags-mcp-2m83f.45 — sites the model put outside the project, beside the model share.
    it("renders the model's external sites next to its edged sites", () => {
      const out = render(
        summary({
          inProjectEdgeRecall: 0.93,
          staticInProjectEdgeRecall: 0.9,
          callsResolvedByModel: 101,
          callsExternalByModel: 340,
          modelResolution: [{ model: "kev", threshold: 0.7, sites: 101, external: 340 }],
        }),
      );

      expect(out).toContain("resolve rate: 0.93 (static 0.9 · model 101 sites · external 340, kev p>=0.7)\n");
    });

    it("renders external sites when the model edged none", () => {
      const out = render(
        summary({
          inProjectEdgeRecall: 0.91,
          staticInProjectEdgeRecall: 0.9,
          callsExternalByModel: 12,
          modelResolution: [{ model: "kev", threshold: 0.7, sites: 0, external: 12 }],
        }),
      );

      expect(out).toContain("resolve rate: 0.91 (static 0.9 · model 0 sites · external 12, kev p>=0.7)\n");
    });

    it("leaves the receiver-kind gap of pre-055 model sites out of the plain form", () => {
      const out = render(
        summary({
          inProjectEdgeRecall: 0.92,
          staticInProjectEdgeRecall: 0.9,
          callsResolvedByModel: 8,
          callsResolvedByModelUnlabeled: 5,
          modelResolution: [{ model: "kev", threshold: 0.7, sites: 8 }],
        }),
      );

      expect(out).toContain("resolve rate: 0.92 (static 0.9 · model 8 sites, kev p>=0.7)\n");
      expect(out).not.toContain("predate migration 055");
    });

    it("says under DEBUG how many model-resolved sites no receiver-kind row counts", () => {
      const out = formatProjectMetrics(
        {
          path: "/p",
          projectName: null,
          status: indexed({
            codegraphResolve: summary({
              callsResolvedByModel: 8,
              callsResolvedByModelUnlabeled: 5,
              byReceiverKind: [
                {
                  receiverKind: "constant",
                  inProjectEdgeRecall: 0.75,
                  coveredRecall: 0.75,
                  attempted: 80,
                  resolved: 60,
                  externalSkipped: 0,
                  unresolvable: 0,
                  callsNoInProjectDef: 0,
                  callsCoreAmbiguous: 0,
                  ambiguousFanout: 0,
                  callsUnnarrowedTemplate: 0,
                  resolveSuccessRate: 0.75,
                },
              ],
            }),
          }),
          metrics: metricsFixture(),
          drift: null,
        },
        {},
      );

      expect(out).toContain(
        "5 model-resolved sites predate migration 055 — in no receiver-kind row; a reindex labels them",
      );
    });
  });
});
