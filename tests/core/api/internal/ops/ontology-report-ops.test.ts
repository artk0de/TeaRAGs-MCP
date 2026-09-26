/**
 * OntologyReportOps (bd tea-rags-mcp-4p3sb.20) — the query behind
 * `get_ontology_report`: turns the DuckDB aggregate rows into the ranked
 * sections, judging naming shapes with the language's canonical casing.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import {
  ONTOLOGY_REPORT_THRESHOLDS,
  ontologyLanguageProfiles,
  OntologyReportOps,
  type OntologyLanguageProfile,
} from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type {
  OntologyReportQuery,
  OntologyReportRows,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
  OntologyTypeGroupRow,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const RUBY: OntologyLanguageProfile = {
  language: "ruby",
  extensions: [".rb"],
  naming: {
    casing: {
      type: ["pascal"],
      module: ["pascal"],
      method: ["snake"],
      param: ["snake"],
      local: ["snake"],
      field: ["snake"],
      constant: ["screamingSnake"],
    },
    nonConceptTypes: ["String", "Integer"],
  },
};
const TS: OntologyLanguageProfile = {
  language: "typescript",
  extensions: [".ts", ".tsx"],
  naming: {
    casing: {
      type: ["pascal"],
      module: ["pascal"],
      method: ["camel"],
      param: ["camel"],
      local: ["camel"],
      field: ["camel"],
      constant: ["camel"],
    },
    nonConceptTypes: ["string", "number"],
  },
};

const at = (relPath: string, line = 1, ownerSymbolId = "Svc#run") => ({ relPath, line, ownerSymbolId });

function rows(partial: Partial<OntologyReportRows> = {}): OntologyReportRows {
  return {
    totals: { identifierRows: 100, symbolRows: 10 },
    evidenceRows: 80,
    genericNameCount: 1,
    genericNames: [
      {
        name: "result",
        typeCount: 9,
        n: 30,
        // Nine unrelated types, 3×4 + 6×3 rows: generic as read.
        types: ["TypeA", "TypeB", "TypeC", "TypeD", "TypeE", "TypeF", "TypeG", "TypeH", "TypeI"].map((typeName, i) => ({
          typeName,
          n: i < 3 ? 4 : 3,
          relPath: "app/x.rb",
        })),
      },
    ],
    ...partial,
  };
}

/** A pooled generic-name candidate: the name and every `[typeName, n, relPath]` it is bound to. */
function genericCandidate(name: string, types: [string, number, string][]) {
  return {
    name,
    typeCount: types.length,
    n: types.reduce((s, [, n]) => s + n, 0),
    types: types.map(([typeName, n, relPath]) => ({ typeName, n, relPath })),
  };
}

function group(partial: Partial<OntologyTypeGroupRow> & Pick<OntologyTypeGroupRow, "typeName" | "names">) {
  const n = partial.names.reduce((s, x) => s + x.n, 0);
  return {
    kind: "local" as const,
    n,
    distinctNames: partial.names.length,
    dominantShare: partial.names[0].n / n,
    entropy: 0.5,
    evidence: { binding: n },
    ...partial,
  };
}

/**
 * A reader over one canned `OntologyReportRows`, served in the two phases the
 * store reads it in: the summary (totals + generic candidates), then the
 * sections with the judged generic names excluded.
 */
function twoPhaseGraphDb(read: (q: OntologyReportQuery) => Promise<OntologyReportRows>) {
  return {
    readOntologyReportSummary: vi.fn(async (q: OntologyReportQuery): Promise<OntologyReportSummaryRows> => {
      const { totals, genericNameCount, genericNames } = await read(q);
      return { totals, genericNameCount, genericNames };
    }),
    readOntologyReportSections: vi.fn(
      async (q: OntologyReportQuery, _excludedGenericNames: readonly string[]): Promise<OntologyReportSectionRows> => {
        const { totals: _t, genericNameCount: _c, genericNames: _g, ...sections } = await read(q);
        return sections;
      },
    ),
  };
}

function makeOps(read: (q: OntologyReportQuery) => Promise<OntologyReportRows>) {
  const graphDb = { ...twoPhaseGraphDb(read), close: vi.fn(async () => undefined) };
  const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
  const ops = new OntologyReportOps({
    pool: pool as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    languages: [RUBY, TS],
  });
  return { ops, graphDb, pool };
}

describe("OntologyReportOps#report — request → query", () => {
  it("forwards the path prefix, language extensions, per-language non-concept types, sections and limit", async () => {
    const { ops, graphDb } = makeOps(async () => rows());
    const res = await ops.report({
      collection: "code_x",
      pathPattern: "app/services/**/*.rb",
      language: "ruby",
      sections: ["homonyms"],
      limit: 7,
    });

    const q = graphDb.readOntologyReportSections.mock.calls[0][0];
    expect(q.pathPrefixes).toEqual(["app/services/"]);
    expect(q.extensions).toEqual([".rb"]);
    expect(q.nonConceptTypes).toEqual([
      { extensions: [".rb"], typeNames: ["String", "Integer"] },
      { extensions: [".ts", ".tsx"], typeNames: ["string", "number"] },
    ]);
    expect(q.sections).toEqual(["homonyms"]);
    expect(q.limit).toBe(7);
    expect(q.thresholds).toEqual({ ...ONTOLOGY_REPORT_THRESHOLDS, groupPool: 28 });
    expect(res.scope).toEqual({ pathPrefix: "app/services/", language: "ruby" });
    expect(graphDb.close).toHaveBeenCalled();
  });

  it("defaults to every section, limit 20 and the whole project", async () => {
    const { ops, graphDb } = makeOps(async () => rows());
    const res = await ops.report({ collection: "code_x" });
    const q = graphDb.readOntologyReportSections.mock.calls[0][0];
    expect(q.sections).toEqual(["synonyms", "homonyms", "outliers", "collisions"]);
    expect(q.limit).toBe(20);
    expect(q.pathPrefixes).toBeUndefined();
    expect(q.extensions).toBeUndefined();
    expect(res.scope).toEqual({ pathPrefix: "" });
  });

  it("rejects a language it has no naming descriptor for", async () => {
    const { ops } = makeOps(async () => rows());
    await expect(ops.report({ collection: "code_x", language: "cobol" })).rejects.toThrow(/language/);
  });
});

describe("OntologyReportOps#report — sections", () => {
  it("synonyms: dominant name and deviants with shapes; plural of the type is not a synonym", async () => {
    const { ops } = makeOps(async () =>
      rows({
        synonyms: [
          group({
            typeName: "TaxAutomationDocument",
            names: [
              { name: "tax_automation_document", n: 3, example: at("app/a.rb", 10) },
              { name: "vendor_envelope", n: 2, example: at("app/b.rb", 4) },
              { name: "doc_row", n: 2, example: at("app/c.rb", 7) },
            ],
          }),
          group({
            typeName: "Invoice",
            names: [
              { name: "invoice", n: 5, example: at("app/i.rb") },
              { name: "invoices", n: 4, example: at("app/i.rb", 9) },
            ],
          }),
        ],
      }),
    );
    const { synonyms } = await ops.report({ collection: "code_x", sections: ["synonyms"] });

    expect(synonyms).toHaveLength(1);
    const [tax] = synonyms ?? [];
    expect(tax).toMatchObject({
      type: "TaxAutomationDocument",
      kind: "local",
      n: 7,
      distinctNames: 3,
      dominant: { name: "tax_automation_document", n: 3, shape: "EXACT" },
      evidence: { binding: 7 },
    });
    expect(tax.dominantShare).toBeCloseTo(3 / 7);
    expect(tax.confidence).toBeCloseTo((7 / 20) ** 2);
    expect(tax.deviants).toEqual([
      { name: "vendor_envelope", n: 2, shape: "FREE", example: { relPath: "app/b.rb", line: 4, symbolId: "Svc#run" } },
      { name: "doc_row", n: 2, shape: "FREE", example: { relPath: "app/c.rb", line: 7, symbolId: "Svc#run" } },
    ]);
  });

  it("homonyms: every type with its share and the name's shape against it", async () => {
    const { ops } = makeOps(async () =>
      rows({
        homonyms: [
          {
            name: "record",
            n: 9,
            topTypeShare: 6 / 9,
            types: [
              { typeName: "Invoice", n: 6, example: at("app/a.rb") },
              { typeName: "Payment", n: 3, example: at("app/b.rb") },
            ],
            evidence: { binding: 8, "call-return": 1 },
          },
        ],
      }),
    );
    const { homonyms } = await ops.report({ collection: "code_x", sections: ["homonyms"] });
    expect(homonyms).toEqual([
      {
        name: "record",
        n: 9,
        confidence: (9 / 20) ** 2,
        topTypeShare: 6 / 9,
        types: [
          { type: "Invoice", n: 6, shape: "FREE", example: { relPath: "app/a.rb", line: 1, symbolId: "Svc#run" } },
          { type: "Payment", n: 3, shape: "FREE", example: { relPath: "app/b.rb", line: 1, symbolId: "Svc#run" } },
        ],
        evidence: { binding: 8, "call-return": 1 },
      },
    ]);
  });

  it("outliers: a name outside the dominant shape family, judged in the language's casing", async () => {
    const { ops } = makeOps(async () =>
      rows({
        outlierGroups: [
          group({
            typeName: "TaxAutomationDocument",
            names: [
              { name: "tax_automation_document", n: 40, example: at("app/a.rb") },
              { name: "tax_automation_document_ignored", n: 5, example: at("app/a.rb", 3) },
              { name: "tad", n: 3, example: at("app/t.rb", 12) },
            ],
          }),
          group({
            typeName: "TaxAutomationDocument",
            names: [
              { name: "taxAutomationDocument", n: 9, example: at("web/a.ts") },
              { name: "tad", n: 1, example: at("web/t.ts", 2) },
            ],
          }),
        ],
      }),
    );
    const { outliers } = await ops.report({ collection: "code_x", sections: ["outliers"] });

    expect(outliers?.map((o) => [o.name, o.example.relPath])).toEqual([
      ["tad", "app/t.rb"],
      ["tad", "web/t.ts"],
    ]);
    expect(outliers?.[0]).toMatchObject({
      type: "TaxAutomationDocument",
      kind: "local",
      n: 3,
      shape: "FREE",
      dominant: { name: "tax_automation_document", n: 40, shape: "EXACT" },
      confidence: 1,
    });
    expect(outliers?.[0].dominant.shapeShare).toBeCloseTo(45 / 48);
    // camelCase is EXACT in TypeScript, not FREE: the casing comes from the file's language.
    expect(outliers?.[1].dominant).toMatchObject({ name: "taxAutomationDocument", shape: "EXACT" });
  });

  it("collisions: mapped with the example's symbol", async () => {
    const { ops } = makeOps(async () =>
      rows({
        collisions: [
          {
            rule: "namesOtherType",
            name: "invoice",
            symbol: "Invoice",
            typeName: "Payment",
            n: 2,
            example: at("app/p.rb", 6),
            evidence: { binding: 2 },
          },
          {
            rule: "shadowsMethod",
            name: "title",
            symbol: "Report#title",
            n: 1,
            example: at("app/r.rb", 3, "Report#render"),
            evidence: { untyped: 1 },
          },
        ],
      }),
    );
    const { collisions } = await ops.report({ collection: "code_x", sections: ["collisions"] });
    expect(collisions).toEqual([
      {
        rule: "namesOtherType",
        name: "invoice",
        symbol: "Invoice",
        type: "Payment",
        n: 2,
        example: { relPath: "app/p.rb", line: 6, symbolId: "Svc#run" },
        evidence: { binding: 2 },
      },
      {
        rule: "shadowsMethod",
        name: "title",
        symbol: "Report#title",
        n: 1,
        example: { relPath: "app/r.rb", line: 3, symbolId: "Report#render" },
        evidence: { untyped: 1 },
      },
    ]);
  });

  it("carries the summary and never emits the reserved conceptSynonyms section", async () => {
    const { ops } = makeOps(async () => rows({ synonyms: [], homonyms: [], outlierGroups: [], collisions: [] }));
    const res = await ops.report({ collection: "code_x" });
    expect(res.summary).toEqual({
      evidenceRows: 80,
      genericNameCount: 1,
      genericNames: [{ name: "result", typeCount: 9, n: 30 }],
    });
    expect(res).not.toHaveProperty("conceptSynonyms");
    expect(res.driftWarning).toBeUndefined();
  });
});

describe("OntologyReportOps#report — degraded states", () => {
  it("an index predating migration 033 (empty table beside symbols) answers a driftWarning", async () => {
    const { ops } = makeOps(async () =>
      rows({
        totals: { identifierRows: 0, symbolRows: 500 },
        evidenceRows: 0,
        genericNameCount: 0,
        genericNames: [],
        homonyms: [],
      }),
    );
    const res = await ops.report({ collection: "code_x", sections: ["homonyms"] });
    expect(res.driftWarning).toMatch(/cg_identifiers/);
    expect(res.driftWarning).toMatch(/reindex/i);
    expect(res.homonyms).toEqual([]);
  });

  it("a missing cg_identifiers table answers a driftWarning instead of throwing", async () => {
    const { ops, graphDb } = makeOps(async () => {
      throw new Error("Catalog Error: Table with name cg_identifiers does not exist!");
    });
    const res = await ops.report({ collection: "code_x" });
    expect(res.driftWarning).toMatch(/cg_identifiers/);
    expect(res.summary.evidenceRows).toBe(0);
    expect(graphDb.close).toHaveBeenCalled();
  });

  it("a zero-row project (no symbols either) is an empty report without a warning", async () => {
    const { ops } = makeOps(async () =>
      rows({
        totals: { identifierRows: 0, symbolRows: 0 },
        evidenceRows: 0,
        genericNameCount: 0,
        genericNames: [],
        synonyms: [],
        homonyms: [],
        outlierGroups: [],
        collisions: [],
      }),
    );
    const res = await ops.report({ collection: "code_x" });
    expect(res).toEqual({
      scope: { pathPrefix: "" },
      summary: { evidenceRows: 0, genericNameCount: 0, genericNames: [] },
      synonyms: [],
      homonyms: [],
      outliers: [],
      collisions: [],
    });
  });

  it("other read errors propagate", async () => {
    const { ops } = makeOps(async () => {
      throw new Error("IO Error: disk on fire");
    });
    await expect(ops.report({ collection: "code_x" })).rejects.toThrow(/disk on fire/);
  });

  // Invariant changed 2026-09-25 (live validation): an unreadable graph used to
  // answer a bare empty report — indistinguishable from a clean project. It now
  // says why, the same notice get_naming_lexicon gives.
  it("a graph that cannot be opened degrades to the empty report with a notice saying why", async () => {
    const pool = {
      acquireReader: vi.fn(async () => {
        throw new Error("lock held");
      }),
    };
    const ops = new OntologyReportOps({ pool, collectionRegistry: {} as never, languages: [RUBY] });
    expect(await ops.report({ collection: "code_x", sections: ["synonyms"] })).toEqual({
      ...OntologyReportOps.empty({ sections: ["synonyms"] }),
      notices: ["codegraph store unavailable: lock held"],
    });
  });
});

describe("OntologyReportOps#report — ranking and resilience", () => {
  it("synonyms rank by (1 − dominant share) × confidence across types; a nameless group is skipped", async () => {
    const { ops } = makeOps(async () =>
      rows({
        synonyms: [
          { ...group({ typeName: "Ghost", names: [{ name: "ghost", n: 1, example: at("app/g.rb") }] }), names: [] },
          group({
            typeName: "Payment",
            names: [
              { name: "payment", n: 4, example: at("app/p.rb") },
              { name: "pmt", n: 3, example: at("app/p.rb", 2) },
              { name: "charge", n: 3, example: at("app/p.rb", 3) },
            ],
          }),
          group({
            typeName: "Invoice",
            names: [
              { name: "invoice", n: 10, example: at("app/i.rb") },
              { name: "bill", n: 10, example: at("app/i.rb", 2) },
              { name: "_", n: 5, example: at("app/i.rb", 3) },
            ],
          }),
        ],
      }),
    );
    const { synonyms } = await ops.report({ collection: "code_x", sections: ["synonyms"] });

    // Invoice: share 0.4, confidence 1 → 0.6; Payment: share 0.4, confidence 0.25 → 0.15.
    expect(synonyms?.map((s) => s.type)).toEqual(["Invoice", "Payment"]);
    expect(synonyms?.[0].dominant).toMatchObject({ name: "invoice", n: 10 });
    expect(synonyms?.[0].deviants.map((d) => d.name)).toEqual(["bill", "_"]);
    expect(synonyms?.[1].confidence).toBeCloseTo(0.25);
  });

  it("outliers need a convention: a group holding a single name yields none", async () => {
    const { ops } = makeOps(async () =>
      rows({
        outlierGroups: [group({ typeName: "Invoice", names: [{ name: "inv", n: 30, example: at("app/i.rb") }] })],
      }),
    );
    const { outliers } = await ops.report({ collection: "code_x", sections: ["outliers"] });
    expect(outliers).toEqual([]);
  });

  it("an alias that cannot be resolved falls back to the physical name; a failing close never masks the report", async () => {
    const graphDb = {
      ...twoPhaseGraphDb(async () => rows({ homonyms: [] })),
      close: vi.fn(async () => {
        throw new Error("already closed");
      }),
    };
    const pool = { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) };
    const ops = new OntologyReportOps({
      pool: pool as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async () => {
        throw new Error("registry offline");
      },
      languages: [RUBY],
    });

    const res = await ops.report({ collection: "code_x", sections: ["homonyms"] });

    expect(pool.acquireReader).toHaveBeenCalledWith("code_x");
    expect(graphDb.close).toHaveBeenCalled();
    expect(res.homonyms).toEqual([]);
    expect(res.summary.evidenceRows).toBe(80);
  });
});

/** A homonym candidate row as the store returns it; `n` is the sum of its types. */
function homonym(name: string, types: [typeName: string, n: number, relPath: string][]) {
  const n = types.reduce((s, [, count]) => s + count, 0);
  return {
    name,
    n,
    topTypeShare: Math.max(...types.map(([, count]) => count)) / n,
    types: types.map(([typeName, count, relPath]) => ({ typeName, n: count, example: at(relPath) })),
    evidence: { binding: n },
  };
}

describe("OntologyReportOps#report — live false positives", () => {
  it("genericNames: a type family's role word (`form` over many `*Form` classes) is not generic", async () => {
    const forms = ["ActionForm", "ClientForm", "InvoiceForm", "TaskForm", "UserForm", "Crm::ContactForm"];
    const { ops } = makeOps(async () =>
      rows({
        genericNameCount: 1,
        genericNames: [
          genericCandidate(
            "form",
            forms.map((f, i) => [f, 10 + i, "app/forms/x.rb"]),
          ),
        ],
      }),
    );
    const res = await ops.report({ collection: "code_x" });
    expect(res.summary.genericNames).toEqual([]);
    expect(res.summary.genericNameCount).toBe(0);
  });

  it("genericNames: counts only the types the name does not spell; generic when those still clear the bar", async () => {
    const { ops } = makeOps(async () =>
      rows({
        genericNames: [
          genericCandidate("actor", [
            ["Actor", 9, "app/a.rb"], // EXACT
            ["Workflow::ProjectActor", 7, "app/b.rb"], // TAIL
            ["System", 3, "app/c.rb"],
            ["Owner", 3, "app/d.rb"],
            ["Crm::User", 2, "app/e.rb"],
            ["Account", 2, "app/f.rb"],
            ["Team", 2, "app/g.rb"],
          ]),
          // Five types, two of them spelled (`Client`, `Billing::Client`): the
          // three unrelated ones fall below genericMinTypes. A HEAD word
          // (`ClientAccount`) is not a spelling.
          genericCandidate("client", [
            ["Client", 6, "app/a.rb"],
            ["Crm::ClientAccount", 3, "app/b.rb"],
            ["Billing::Client", 3, "app/c.rb"],
            ["Account", 2, "app/d.rb"],
            ["Contact", 2, "app/e.rb"],
          ]),
          genericCandidate("result", [
            ["TypeA", 2, "app/a.rb"],
            ["TypeB", 2, "app/a.rb"],
            ["TypeC", 2, "app/a.rb"],
            ["TypeD", 2, "app/a.rb"],
            ["TypeE", 2, "app/a.rb"],
          ]),
        ],
        genericNameCount: 3,
      }),
    );
    const res = await ops.report({ collection: "code_x" });
    expect(res.summary.genericNames).toEqual([
      { name: "actor", typeCount: 5, n: 12 },
      { name: "result", typeCount: 5, n: 10 },
    ]);
    expect(res.summary.genericNameCount).toBe(2);
  });

  it("genericNames: capped at limit AFTER the drop, and the count is of the names still generic", async () => {
    const { ops } = makeOps(async () =>
      rows({
        genericNames: [
          // The largest candidate, but EXACT for its dominant type in the TypeScript file.
          genericCandidate("docNode", [
            ["DocNode", 6, "src/a.ts"],
            ["Alpha", 3, "src/a.ts"],
            ["Beta", 3, "src/a.ts"],
            ["Gamma", 3, "src/a.ts"],
            ["Delta", 3, "src/a.ts"],
          ]),
          genericCandidate("data", [
            ["TypeA", 3, "app/a.rb"],
            ["TypeB", 3, "app/a.rb"],
            ["TypeC", 3, "app/a.rb"],
            ["TypeD", 3, "app/a.rb"],
            ["TypeE", 3, "app/a.rb"],
          ]),
          genericCandidate("item", [
            ["TypeA", 2, "app/a.rb"],
            ["TypeB", 2, "app/a.rb"],
            ["TypeC", 2, "app/a.rb"],
            ["TypeD", 2, "app/a.rb"],
            ["TypeE", 2, "app/a.rb"],
          ]),
        ],
        genericNameCount: 3,
      }),
    );
    const res = await ops.report({ collection: "code_x", limit: 1 });
    expect(res.summary.genericNames).toEqual([{ name: "data", typeCount: 5, n: 15 }]);
    expect(res.summary.genericNameCount).toBe(2);
  });

  it("homonyms: a role word every type ends in, each a different class, is not a homonym", async () => {
    const { ops } = makeOps(async () =>
      rows({
        homonyms: [
          homonym("symbolTable", [
            ["InMemoryGlobalSymbolTable", 6, "src/a.ts"],
            ["GlobalSymbolTable", 5, "src/b.ts"],
          ]),
          homonym("state", [
            ["ClientState", 4, "src/a.ts"],
            ["ChunkPhaseState", 3, "src/b.ts"],
            ["FilePhaseState", 3, "src/c.ts"],
            ["CodegraphRunState", 2, "src/d.ts"],
          ]),
          homonym("composer", [
            ["DefaultSymbolIdComposer", 4, "src/a.ts"],
            ["SymbolIdComposer", 3, "src/b.ts"],
          ]),
          homonym("facts", [
            ["RubyTypeFact", 4, "src/a.ts"],
            ["TypeFact", 3, "src/b.ts"],
          ]),
          homonym("connection", [
            ["Bookkeeping::QBO::Connection", 4, "app/a.rb"],
            ["Communication::TwilioConnection", 3, "app/b.rb"],
            ["GettingPaid::StripeConnection", 3, "app/c.rb"],
          ]),
          homonym("result", [
            ["KindOfService::Result", 6, "app/a.rb"],
            ["Crm::Api::Account", 4, "app/b.rb"],
          ]),
          homonym("invoice", [
            ["Billing::Invoice", 6, "app/a.rb"],
            ["GettingPaid::Bill", 4, "app/b.rb"],
          ]),
          homonym("subscription", [
            ["GrowthBilling::Subscription", 5, "app/a.rb"],
            ["Subscriptions::Subscription", 5, "app/b.rb"],
          ]),
        ],
      }),
    );
    const { homonyms } = await ops.report({ collection: "code_x", sections: ["homonyms"] });
    expect(homonyms?.map((h) => h.name).sort()).toEqual(["invoice", "result", "subscription"]);
  });

  it("homonyms: an unqualified spelling folds into the one qualified type sharing its last segment", async () => {
    const { ops } = makeOps(async () =>
      rows({
        homonyms: [
          homonym("@document", [
            ["TaxPreparation::Document", 27, "app/a.rb"],
            ["Document", 10, "app/b.rb"],
          ]),
          homonym("request", [
            ["Request", 5, "app/a.rb"],
            ["Invoice", 4, "app/b.rb"],
            ["ActionDispatch::Request", 3, "app/c.rb"],
          ]),
        ],
      }),
    );
    const { homonyms } = await ops.report({ collection: "code_x", sections: ["homonyms"] });
    expect(homonyms?.map((h) => h.name)).toEqual(["request"]);
    const [request] = homonyms ?? [];
    expect(request.types.map((t) => [t.type, t.n])).toEqual([
      ["ActionDispatch::Request", 8],
      ["Invoice", 4],
    ]);
    expect(request.topTypeShare).toBeCloseTo(8 / 12);
    // The merged type keeps the qualified spelling's example.
    expect(request.types[0].example.relPath).toBe("app/c.rb");
  });

  it("homonyms: judged over the pooled candidates, then capped at limit and namesPerItem", async () => {
    const many = Array.from({ length: 8 }, (_, i): [string, number, string] => [`Type${"ABCDEFGH"[i]}`, 3, "app/t.rb"]);
    const { ops, graphDb } = makeOps(async () =>
      rows({
        homonyms: [
          homonym("state", [
            ["ClientState", 6, "src/a.ts"],
            ["RunState", 5, "src/b.ts"],
          ]),
          homonym("record", many),
          homonym("entry", [
            ["Invoice", 6, "app/a.rb"],
            ["Payment", 5, "app/b.rb"],
          ]),
        ],
      }),
    );
    const { homonyms } = await ops.report({ collection: "code_x", sections: ["homonyms"], limit: 1 });
    expect(graphDb.readOntologyReportSections.mock.calls[0][0].thresholds.groupPool).toBeGreaterThan(1);
    expect(homonyms?.map((h) => h.name)).toEqual(["record"]);
    expect(homonyms?.[0].types).toHaveLength(ONTOLOGY_REPORT_THRESHOLDS.namesPerItem);
  });

  it("outliers: a name EXACT for its type is the canonical spelling, never an outlier", async () => {
    const { ops } = makeOps(async () =>
      rows({
        outlierGroups: [
          group({
            typeName: "Error",
            names: [
              { name: "cause", n: 40, example: at("src/a.ts") },
              { name: "error", n: 3, example: at("src/b.ts") },
            ],
          }),
        ],
      }),
    );
    const { outliers } = await ops.report({ collection: "code_x", sections: ["outliers"] });
    expect(outliers).toEqual([]);
  });

  it("homonyms: an abbreviated role word (`ctx`, `err`) is dropped; `run` and `node` stay", async () => {
    const { ops } = makeOps(async () =>
      rows({
        homonyms: [
          homonym("ctx", [
            ["LogContext", 6, "src/a.ts"],
            ["ProviderContext", 4, "src/b.ts"],
            ["ReindexContext", 3, "src/c.ts"],
          ]),
          homonym("err", [
            ["Error", 8, "src/a.ts"],
            ["QuarantinableIngestError", 4, "src/b.ts"],
            ["NodeJS.ErrnoException", 3, "src/c.ts"],
          ]),
          homonym("run", [
            ["EnrichmentRunHandle", 5, "src/a.ts"],
            ["RunMarker", 4, "src/b.ts"],
            ["RunState", 3, "src/c.ts"],
          ]),
          homonym("node", [
            ["AstNode", 6, "src/a.ts"],
            ["Content", 4, "src/b.ts"],
          ]),
        ],
      }),
    );
    const { homonyms } = await ops.report({ collection: "code_x", sections: ["homonyms"] });
    expect(homonyms?.map((h) => h.name).sort()).toEqual(["node", "run"]);
  });

  it("outliers: a name is one only when its shape is weaker than the dominant's", async () => {
    const { ops } = makeOps(async () =>
      rows({
        outlierGroups: [
          // TAIL against a FREE convention: the more descriptive name is not the outlier.
          group({
            typeName: "PhysicalCollectionName",
            names: [
              { name: "coll", n: 11, example: at("src/a.ts") },
              { name: "collectionName", n: 4, example: at("src/b.ts") },
            ],
          }),
          group({
            typeName: "CodegraphChunkHandoff",
            names: [
              { name: "deferredChunkHandoff", n: 8, example: at("src/a.ts") },
              { name: "handoff", n: 2, example: at("src/b.ts") },
            ],
          }),
          // FREE against a TAIL convention stays an outlier.
          group({
            typeName: "ChunkItem",
            names: [
              { name: "items", n: 12, example: at("src/a.ts") },
              { name: "entries", n: 2, example: at("src/c.ts") },
            ],
          }),
          // A qualifier before the type's tail is still TAIL: not weaker than the bare tail.
          group({
            typeName: "ChunkItem",
            names: [
              { name: "items", n: 12, example: at("src/a.ts") },
              { name: "fileItems", n: 2, example: at("src/d.ts") },
            ],
          }),
        ],
      }),
    );
    const { outliers } = await ops.report({ collection: "code_x", sections: ["outliers"] });
    expect(outliers?.map((o) => [o.type, o.name, o.shape, o.dominant.shape])).toEqual([
      ["ChunkItem", "entries", "FREE", "TAIL"],
    ]);
  });

  it("synonyms: a type whose dominant name occurs once is a set of singleton instances, not synonyms", async () => {
    const { ops } = makeOps(async () =>
      rows({
        synonyms: [
          group({
            typeName: "ChunkingHook",
            names: ["jsTestDslFilterHook", "rspecFilterHook", "pythonHook", "rubyHook", "goHook"].map((name, i) => ({
              name,
              n: 1,
              example: at("src/hooks.ts", i + 1),
            })),
          }),
        ],
      }),
    );
    const { synonyms } = await ops.report({ collection: "code_x", sections: ["synonyms"] });
    expect(synonyms).toEqual([]);
  });
});

describe("OntologyReportOps#report — the sections exclude the JUDGED generic names", () => {
  it("reads the summary once, then the sections excluding every judged name, uncapped by limit", async () => {
    const unrelated = (count: number): [string, number, string][] =>
      ["TypeA", "TypeB", "TypeC", "TypeD", "TypeE"].map((t) => [t, count, "app/a.rb"]);
    const { ops, graphDb } = makeOps(async () =>
      rows({
        genericNames: [
          genericCandidate(
            "form",
            ["SignupForm", "ActionForm", "ClientForm", "InvoiceForm", "TaskForm"].map((f) => [f, 4, "app/forms/x.rb"]),
          ),
          genericCandidate("actor", unrelated(3)),
          genericCandidate("data", unrelated(2)),
        ],
        genericNameCount: 3,
      }),
    );
    const res = await ops.report({ collection: "code_x", limit: 1 });

    expect(res.summary.genericNames).toEqual([{ name: "actor", typeCount: 5, n: 15 }]);
    expect(res.summary.genericNameCount).toBe(2);
    expect(graphDb.readOntologyReportSummary).toHaveBeenCalledTimes(1);
    expect(graphDb.readOntologyReportSections).toHaveBeenCalledTimes(1);
    // `form` is a role word, not generic: its rows stay evidence. The cap on the summary is not the exclusion.
    expect(graphDb.readOntologyReportSections.mock.calls[0][1]).toEqual(["actor", "data"]);
    expect(graphDb.readOntologyReportSections.mock.calls[0][0]).toEqual(
      graphDb.readOntologyReportSummary.mock.calls[0][0],
    );
  });

  it("end to end over DuckDB: a role word stays in the sections, a generic name leaves them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ontology-ops-"));
    const db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    try {
      await db.init();
      await runMigrations(db, DATABASE_MIGRATIONS);
      const local = (name: string, typeName: string, line: number) => ({
        ownerSymbolId: "Svc#run",
        kind: "local" as const,
        name,
        line,
        typeName,
        typeSource: "binding" as const,
      });
      const repeat = (count: number, name: string, typeName: string, firstLine: number) =>
        Array.from({ length: count }, (_, i) => local(name, typeName, firstLine + i));
      await db.replaceIdentifiersBulk([
        {
          relPath: "app/forms/signup.rb",
          rows: [
            ...repeat(3, "form", "SignupForm", 1),
            ...repeat(1, "signup", "SignupForm", 10),
            ...repeat(1, "registration", "SignupForm", 20),
            ...["ActionForm", "ClientForm", "InvoiceForm", "TaskForm"].flatMap((t, i) =>
              repeat(2, "form", t, 100 + 10 * i),
            ),
          ],
        },
        {
          relPath: "app/actors/actor.rb",
          rows: [
            ...["Person", "Robot", "Queue", "Mailer", "Clock"].flatMap((t, i) => repeat(2, "actor", t, 10 * (i + 1))),
            ...repeat(2, "person", "Person", 100),
            ...repeat(1, "human", "Person", 110),
          ],
        },
      ]);
      const ops = new OntologyReportOps({
        pool: { acquireReader: async () => ({ graphDb: db, symbolTable: {} }) } as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async (n: string) => n as never,
        languages: [RUBY, TS],
      });

      const res = await ops.report({ collection: "code_x", sections: ["synonyms", "homonyms"] });

      expect(res.summary.genericNames.map((g) => g.name)).toEqual(["actor"]);
      // 11 form + signup + registration + 2 person + human; the 10 actor rows are not evidence.
      expect(res.summary.evidenceRows).toBe(16);
      const signup = res.synonyms?.find((s) => s.type === "SignupForm");
      expect(signup?.dominant).toMatchObject({ name: "form", n: 3 });
      expect(res.synonyms?.map((s) => s.type)).not.toContain("Person");
      expect(res.homonyms?.map((h) => h.name)).not.toContain("actor");
    } finally {
      await db.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ontologyLanguageProfiles", () => {
  it("derives one profile per language that declares naming, with its file extensions", () => {
    const profiles = ontologyLanguageProfiles();
    const ruby = profiles.find((p) => p.language === "ruby");
    expect(ruby?.extensions).toContain(".rb");
    expect(ruby?.naming.casing.local[0]).toBe("snake");
    expect(profiles.every((p) => p.extensions.length > 0)).toBe(true);
    expect(profiles.some((p) => p.language === "markdown")).toBe(false);
  });
});
