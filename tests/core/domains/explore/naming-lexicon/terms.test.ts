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

  it("returns nothing for no holders", () => {
    expect(extractConceptTerms([])).toEqual([]);
  });
});
