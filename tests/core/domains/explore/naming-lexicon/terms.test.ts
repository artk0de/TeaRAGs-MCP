import { describe, expect, it } from "vitest";

import { extractConceptTerms } from "../../../../../src/core/domains/explore/naming-lexicon/terms.js";

const HOLDERS = [
  {
    symbolId: "TaxPreparation::TaxAutomations::Document#sync",
    relativePath: "app/models/tax_preparation/tax_automations/document.rb",
    score: 0.9,
  },
  {
    symbolId: "TaxPreparation::TaxAutomations::DocumentsController#show",
    relativePath: "app/controllers/tax_preparation/tax_automations/documents_controller.rb",
    score: 0.8,
  },
  {
    symbolId: "Workflow::TaxAutomationDocumentSyncer#call",
    relativePath: "app/services/workflow/tax_automation_document_syncer.rb",
    score: 0.7,
  },
];

describe("extractConceptTerms", () => {
  it("ranks the shared concept n-gram above per-holder noise", () => {
    const terms = extractConceptTerms(HOLDERS);
    expect(terms[0]?.term).toBe("tax_automation_document");
    expect(terms[0]?.score).toBeCloseTo(2.4);
    expect(terms[0]?.holders).toEqual([
      "TaxPreparation::TaxAutomations::Document#sync",
      "TaxPreparation::TaxAutomations::DocumentsController#show",
      "Workflow::TaxAutomationDocumentSyncer#call",
    ]);
    const show = terms.find((t) => t.term === "show");
    expect(show === undefined || show.score < terms[0].score).toBe(true);
  });

  it("normalizes plural words to singular so namespaces and class names meet", () => {
    const terms = extractConceptTerms(HOLDERS, 50).map((t) => t.term);
    expect(terms).toContain("tax_automation");
    expect(terms).not.toContain("tax_automations");
  });

  it("drops src / lib / app path segments and the file extension", () => {
    const terms = extractConceptTerms([{ symbolId: "parse", relativePath: "src/lib/app/parser.ts", score: 1 }], 50).map(
      (t) => t.term,
    );
    expect(terms).toEqual(expect.arrayContaining(["parse", "parser"]));
    for (const noise of ["src", "lib", "app", "ts", "rb"]) expect(terms).not.toContain(noise);
  });

  it("counts a term once per holder even when symbol and path both carry it", () => {
    const [top] = extractConceptTerms([{ symbolId: "Invoice#total", relativePath: "billing/invoice.rb", score: 0.5 }]);
    expect(top).toMatchObject({ score: 0.5 });
  });

  it("n-grams are 1..3 consecutive words", () => {
    const terms = extractConceptTerms([{ symbolId: "AlphaBetaGammaDelta", relativePath: "x.rb", score: 1 }], 100).map(
      (t) => t.term,
    );
    expect(terms).toContain("alpha_beta_gamma");
    expect(terms).not.toContain("alpha_beta_gamma_delta");
  });

  it("keeps at most three holders per term, best score first", () => {
    const holders = [0.1, 0.4, 0.3, 0.2].map((score, i) => ({ symbolId: `Ledger#m${i}`, relativePath: "", score }));
    const ledger = extractConceptTerms(holders).find((t) => t.term === "ledger");
    expect(ledger?.holders).toEqual(["Ledger#m1", "Ledger#m2", "Ledger#m3"]);
  });

  it("defaults to 10 terms and honours an explicit limit", () => {
    expect(extractConceptTerms(HOLDERS)).toHaveLength(10);
    expect(extractConceptTerms(HOLDERS, 3)).toHaveLength(3);
  });

  describe("directory segments are not concept terms (tea-rags-mcp-4p3sb)", () => {
    const STATS_HOLDERS = [
      {
        symbolId: "SignalValuesAccumulator#result",
        relativePath: "src/core/domains/ingest/infra/signal-values-accumulator.ts",
        score: 3.1,
      },
      {
        symbolId: "computePerSignalStats#part1",
        relativePath: "src/core/domains/ingest/infra/collection-stats.ts",
        score: 3.0,
      },
      {
        symbolId: "CollectionSignalStats",
        relativePath: "src/core/contracts/types/trajectory.ts",
        score: 2.9,
      },
      {
        symbolId: "IndexMetricsQuery#buildSignalMetrics#part1",
        relativePath: "src/core/domains/explore/queries/index-metrics.ts",
        score: 2.8,
      },
      {
        symbolId: "collectMissingPercentilesGrouped",
        relativePath: "src/core/infra/stats-cache.ts",
        score: 2.7,
      },
    ];

    it("never yields a word or n-gram read off a holder's directory path", () => {
      const terms = extractConceptTerms(STATS_HOLDERS, 100).map((t) => t.term);
      for (const noise of ["core", "domain", "ingest", "infra", "core_domain", "core_domain_ingest", "domain_ingest"]) {
        expect(terms).not.toContain(noise);
      }
    });

    it("ranks identifier words on top", () => {
      const terms = extractConceptTerms(STATS_HOLDERS).map((t) => t.term);
      expect(terms[0]).toBe("signal");
      expect(terms.slice(0, 4)).toEqual(expect.arrayContaining(["signal", "stat"]));
      const all = extractConceptTerms(STATS_HOLDERS, 100).map((t) => t.term);
      expect(all).toEqual(expect.arrayContaining(["collection", "percentile"]));
    });

    it("drops the chunker's #partN split suffix", () => {
      const terms = extractConceptTerms(STATS_HOLDERS, 100).map((t) => t.term);
      expect(terms.filter((term) => /part\d/.test(term))).toEqual([]);
    });

    it("names a holder by its symbol, not by a #partN window, once per term", () => {
      const holders = [
        { symbolId: "computePerSignalStats#part1", relativePath: "src/a.ts", score: 3.0 },
        { symbolId: "computePerSignalStats#part2", relativePath: "src/a.ts", score: 2.9 },
        { symbolId: "IndexMetricsQuery#buildSignalMetrics#part1", relativePath: "src/b.ts", score: 2.8 },
        { symbolId: "CollectionSignalStats", relativePath: "src/c.ts", score: 2.7 },
      ];
      const signal = extractConceptTerms(holders, 100).find((t) => t.term === "signal");
      expect(signal?.holders).toEqual([
        "computePerSignalStats",
        "IndexMetricsQuery#buildSignalMetrics",
        "CollectionSignalStats",
      ]);
    });
  });

  it("returns nothing for no holders", () => {
    expect(extractConceptTerms([])).toEqual([]);
  });
});
