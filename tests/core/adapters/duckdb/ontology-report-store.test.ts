/**
 * `readOntologyReport` — the project-wide naming ontology audit over
 * `cg_identifiers` (bd tea-rags-mcp-4p3sb.20), aggregated in DuckDB.
 *
 * One fixture carries every collision class plus the rows the filters must
 * drop:
 *   - synonyms: `TaxAutomationDocument` locals scatter over three names;
 *   - homonyms: `record` is bound to both `Invoice` and `Payment`;
 *   - outlier candidates: `Invoice` params are `invoice` ×8 and `inv` ×1;
 *   - generic: `result` is bound to five unrelated types — judged nowhere;
 *   - non-concept: `String`-typed Ruby rows and a single-letter generic;
 *   - collisions: a `Payment` named `invoice` beside class `Invoice`, a
 *     `CreditInvoice` named `invoice` (a subtype — no collision), and a local
 *     `title` shadowing `Report#title`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  IdentifierRow,
  OntologyReportQuery,
  OntologyReportThresholds,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const THRESHOLDS: OntologyReportThresholds = {
  minSupport: 5,
  synonymDominantShareCeiling: 0.8,
  genericMinTypes: 5,
  genericMaxTopTypeShare: 0.5,
  homonymMinTypeRows: 2,
  homonymMinTypeShare: 0.1,
  outlierMinDominantShare: 0.5,
  confidenceSupport: 20,
  namesPerItem: 6,
  groupPool: 40,
};

function query(partial: Partial<OntologyReportQuery> = {}): OntologyReportQuery {
  return {
    nonConceptTypes: [{ extensions: [".rb"], typeNames: ["String"] }],
    sections: ["synonyms", "homonyms", "outliers", "collisions"],
    limit: 20,
    thresholds: THRESHOLDS,
    ...partial,
  };
}

function rows(count: number, row: Omit<IdentifierRow, "line">, firstLine = 1): IdentifierRow[] {
  return Array.from({ length: count }, (_, i) => ({ ...row, line: firstLine + i }));
}

function typed(name: string, typeName: string, kind: IdentifierRow["kind"] = "local"): Omit<IdentifierRow, "line"> {
  return { ownerSymbolId: "Svc#run", kind, name, typeName, typeSource: "binding" };
}

describe("DuckDbGraphClient#readOntologyReport", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-ontology-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);

    await db.replaceIdentifiersBulk([
      {
        relPath: "app/services/tax.rb",
        rows: [
          ...rows(3, typed("tax_automation_document", "TaxAutomationDocument"), 10),
          ...rows(2, typed("vendor_envelope", "TaxAutomationDocument"), 20),
          ...rows(2, typed("doc_row", "TaxAutomationDocument"), 30),
        ],
      },
      {
        relPath: "app/services/billing.rb",
        rows: [
          ...rows(8, typed("invoice", "Invoice", "param"), 10),
          ...rows(1, typed("inv", "Invoice", "param"), 30),
          ...rows(3, typed("record", "Invoice"), 40),
          ...rows(3, typed("record", "Payment"), 50),
          ...rows(1, typed("invoice", "Payment"), 60),
          ...rows(1, typed("invoice", "CreditInvoice"), 70),
          ...rows(6, typed("user", "User"), 80),
        ],
      },
      {
        relPath: "app/services/generic.rb",
        rows: ["A", "B", "C", "D", "E"].flatMap((t, i) => rows(2, typed("result", `Type${t}`), 10 * (i + 1))),
      },
      {
        relPath: "app/services/strings.rb",
        rows: [
          ...rows(3, typed("label", "String"), 1),
          ...rows(3, typed("title", "String"), 10),
          ...rows(6, typed("item", "T"), 20),
        ],
      },
      {
        relPath: "app/views/report.rb",
        rows: [{ ownerSymbolId: "Report#render", kind: "local", name: "title", line: 3 }],
      },
      {
        relPath: "web/app.ts",
        rows: rows(3, typed("record", "Invoice"), 1),
      },
    ]);
    await db.upsertSymbols("app/models/invoice.rb", [
      { symbolId: "Invoice", fqName: "Invoice", shortName: "Invoice", relPath: "app/models/invoice.rb", scope: [] },
    ]);
    await db.upsertSymbols("app/views/report.rb", [
      {
        symbolId: "Report#title",
        fqName: "Report#title",
        shortName: "title",
        relPath: "app/views/report.rb",
        scope: [],
      },
      {
        symbolId: "Report#render",
        fqName: "Report#render",
        shortName: "render",
        relPath: "app/views/report.rb",
        scope: [],
      },
    ]);
    await db.run(
      `INSERT INTO cg_symbols_inheritance (source_fq_name, source_rel_path, ancestor_fq_name, kind, ordinal)
       VALUES ('CreditInvoice', 'app/models/credit_invoice.rb', 'Invoice', 'superclass', 0)`,
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports whole-table totals and the generic names it filtered", async () => {
    const report = await db.readOntologyReport(query());
    expect(report.totals).toEqual({ identifierRows: 56, symbolRows: 3 });
    expect(report.genericNames).toEqual([{ name: "result", typeCount: 5, n: 10 }]);
    expect(report.genericNameCount).toBe(1);
    // 7 tax + 23 billing + 3 web; generic, String, T and the untyped local are not evidence.
    expect(report.evidenceRows).toBe(33);
  });

  it("synonyms: a type whose names scatter, top name first, with counts, examples and evidence", async () => {
    const { synonyms } = await db.readOntologyReport(query({ sections: ["synonyms"] }));
    expect(synonyms).toHaveLength(1);
    const [group] = synonyms ?? [];
    expect(group).toMatchObject({ typeName: "TaxAutomationDocument", kind: "local", n: 7, distinctNames: 3 });
    expect(group.dominantShare).toBeCloseTo(3 / 7);
    const expectedEntropy = -[3, 2, 2].reduce((s, c) => s + (c / 7) * Math.log(c / 7), 0) / Math.log(3);
    expect(group.entropy).toBeCloseTo(expectedEntropy);
    expect(group.names.map((n) => [n.name, n.n])).toEqual([
      ["tax_automation_document", 3],
      ["doc_row", 2],
      ["vendor_envelope", 2],
    ]);
    expect(group.names[0].example).toEqual({ relPath: "app/services/tax.rb", line: 10, ownerSymbolId: "Svc#run" });
    expect(group.evidence).toEqual({ binding: 7 });
  });

  it("homonyms: a name bound to two concept types; the generic name is not one", async () => {
    const { homonyms } = await db.readOntologyReport(query({ sections: ["homonyms"] }));
    expect(homonyms?.map((h) => h.name)).toEqual(["record"]);
    const [record] = homonyms ?? [];
    expect(record.n).toBe(9);
    expect(record.topTypeShare).toBeCloseTo(6 / 9);
    expect(record.types.map((t) => [t.typeName, t.n])).toEqual([
      ["Invoice", 6],
      ["Payment", 3],
    ]);
    expect(record.types[0].example.relPath).toBe("app/services/billing.rb");
  });

  it("outlier candidates: groups with a dominant name, their names capped per item", async () => {
    const { outlierGroups } = await db.readOntologyReport(query({ sections: ["outliers"] }));
    const invoiceParams = outlierGroups?.find((g) => g.typeName === "Invoice" && g.kind === "param");
    expect(invoiceParams?.names.map((n) => [n.name, n.n])).toEqual([
      ["invoice", 8],
      ["inv", 1],
    ]);
    // Single-name groups hold no deviant; scattered groups are the synonyms' job.
    expect(outlierGroups?.some((g) => g.typeName === "User")).toBe(false);
    expect(outlierGroups?.some((g) => g.typeName === "TaxAutomationDocument")).toBe(false);
  });

  it("collisions: a value named after another type and a local shadowing a method; a subtype is not one", async () => {
    const { collisions } = await db.readOntologyReport(query({ sections: ["collisions"] }));
    expect(collisions).toEqual([
      {
        rule: "namesOtherType",
        name: "invoice",
        symbol: "Invoice",
        typeName: "Payment",
        n: 1,
        example: { relPath: "app/services/billing.rb", line: 60, ownerSymbolId: "Svc#run" },
        evidence: { binding: 1 },
      },
      {
        rule: "shadowsMethod",
        name: "title",
        symbol: "Report#title",
        n: 1,
        example: { relPath: "app/views/report.rb", line: 3, ownerSymbolId: "Report#render" },
        evidence: { untyped: 1 },
      },
    ]);
  });

  it("scopes every section by rel_path prefix and by file extension", async () => {
    const byPrefix = await db.readOntologyReport(query({ pathPrefixes: ["app/services/tax"] }));
    expect(byPrefix.evidenceRows).toBe(7);
    expect(byPrefix.homonyms).toEqual([]);
    expect(byPrefix.synonyms?.map((s) => s.typeName)).toEqual(["TaxAutomationDocument"]);

    const rubyOnly = await db.readOntologyReport(query({ extensions: [".rb"] }));
    expect(rubyOnly.evidenceRows).toBe(30);
    expect(rubyOnly.homonyms?.[0].types.map((t) => [t.typeName, t.n])).toEqual([
      ["Invoice", 3],
      ["Payment", 3],
    ]);
  });

  it("drops non-concept types only in the language that declares them", async () => {
    const report = await db.readOntologyReport(
      query({ nonConceptTypes: [{ extensions: [".ts"], typeNames: ["String"] }] }),
    );
    // The Ruby String rows now count: label ×3 and title ×3 scatter over String.
    expect(report.synonyms?.map((s) => s.typeName)).toContain("String");
  });

  it("a non-concept group naming no extension or no type excludes nothing", async () => {
    const report = await db.readOntologyReport(
      query({
        nonConceptTypes: [
          { extensions: [], typeNames: ["String"] },
          { extensions: [".rb"], typeNames: [] },
        ],
      }),
    );
    expect(report.synonyms?.map((s) => s.typeName)).toContain("String");
  });

  it("refuses a non-finite threshold instead of interpolating it into SQL", async () => {
    await expect(
      db.readOntologyReport(query({ thresholds: { ...THRESHOLDS, synonymDominantShareCeiling: Number.NaN } })),
    ).rejects.toThrow(/non-finite threshold/);
  });

  it("reads only the requested sections", async () => {
    const report = await db.readOntologyReport(query({ sections: ["homonyms"] }));
    expect(report.homonyms).toBeDefined();
    expect(report.synonyms).toBeUndefined();
    expect(report.outlierGroups).toBeUndefined();
    expect(report.collisions).toBeUndefined();
  });

  it("types a row through its bound call's return (call-return) and counts it apart", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/services/finder.rb",
        rows: [
          {
            ownerSymbolId: "Finder#find_doc!",
            kind: "return",
            name: "find_doc!",
            line: 1,
            typeName: "TaxAutomationDocument",
            typeSource: "return-type",
          },
        ],
      },
      {
        relPath: "app/jobs/job.rb",
        rows: [
          {
            ownerSymbolId: "Job#perform",
            kind: "local",
            name: "vendor_envelope",
            line: 4,
            boundMember: "find_doc!",
            boundCallExpression: "find_doc!(id)",
          },
        ],
      },
    ]);
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key,
          target_symbol_id, edge_kind, confidence)
       VALUES ('Job#perform', 'app/jobs/job.rb', 'app/services/finder.rb', 'find_doc!(id)',
               'Finder#find_doc!', 'Finder#find_doc!', 'exact', 1.0)`,
    );
    const { synonyms } = await db.readOntologyReport(query({ sections: ["synonyms"] }));
    const tax = synonyms?.find((s) => s.typeName === "TaxAutomationDocument");
    expect(tax?.n).toBe(8);
    expect(tax?.evidence).toEqual({ binding: 7, "call-return": 1 });
  });

  it("an empty table yields empty sections and zero counts", async () => {
    await db.run("DELETE FROM cg_identifiers");
    const report = await db.readOntologyReport(query());
    expect(report).toEqual({
      totals: { identifierRows: 0, symbolRows: 3 },
      evidenceRows: 0,
      genericNameCount: 0,
      genericNames: [],
      synonyms: [],
      homonyms: [],
      outlierGroups: [],
      collisions: [],
    });
  });
});
