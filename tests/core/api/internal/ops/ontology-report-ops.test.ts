/**
 * OntologyReportOps (bd tea-rags-mcp-4p3sb.20) — the query behind
 * `get_ontology_report`: turns the DuckDB aggregate rows into the ranked
 * sections, judging naming shapes with the language's canonical casing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  ONTOLOGY_REPORT_THRESHOLDS,
  ontologyLanguageProfiles,
  OntologyReportOps,
  type OntologyLanguageProfile,
} from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type {
  OntologyReportQuery,
  OntologyReportRows,
  OntologyTypeGroupRow,
} from "../../../../../src/core/contracts/types/codegraph.js";

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
    genericNames: [{ name: "result", typeCount: 9, n: 30 }],
    ...partial,
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

function makeOps(read: (q: OntologyReportQuery) => Promise<OntologyReportRows>) {
  const graphDb = { readOntologyReport: vi.fn(read), close: vi.fn(async () => undefined) };
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

    const q = graphDb.readOntologyReport.mock.calls[0][0];
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
    const q = graphDb.readOntologyReport.mock.calls[0][0];
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
      readOntologyReport: vi.fn(async () => rows({ homonyms: [] })),
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
    expect(graphDb.readOntologyReport.mock.calls[0][0].thresholds.groupPool).toBeGreaterThan(1);
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
