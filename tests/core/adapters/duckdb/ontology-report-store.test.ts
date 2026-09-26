/**
 * `readOntologyReportSummary` + `readOntologyReportSections` — the project-wide
 * naming ontology audit over `cg_identifiers` (bd tea-rags-mcp-4p3sb.20),
 * aggregated in DuckDB. `readReport` composes the two phases the way the ops
 * layer does, with every generic CANDIDATE excluded (no judgement here), so a
 * case can assert the summary and the sections of one scope together.
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
  OntologyReportRows,
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

/** `result`'s five types in the fixture, as the generic-name pool carries them for the ops layer to judge. */
const RESULT_TYPES = ["TypeA", "TypeB", "TypeC", "TypeD", "TypeE"].map((typeName) => ({
  typeName,
  n: 2,
  relPath: "app/services/generic.rb",
}));

function rows(count: number, row: Omit<IdentifierRow, "line">, firstLine = 1): IdentifierRow[] {
  return Array.from({ length: count }, (_, i) => ({ ...row, line: firstLine + i }));
}

function typed(name: string, typeName: string, kind: IdentifierRow["kind"] = "local"): Omit<IdentifierRow, "line"> {
  return { ownerSymbolId: "Svc#run", kind, name, typeName, typeSource: "binding" };
}

describe("DuckDbGraphClient#readOntologyReportSummary / #readOntologyReportSections", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  /** Both phases, the sections excluding every generic candidate of the summary. */
  const readReport = async (q: OntologyReportQuery): Promise<OntologyReportRows> => {
    const summary = await db.readOntologyReportSummary(q);
    const sections = await db.readOntologyReportSections(
      q,
      summary.genericNames.map((g) => g.name),
    );
    return { ...summary, ...sections };
  };

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
    const report = await readReport(query());
    expect(report.totals).toEqual({ identifierRows: 56, symbolRows: 3 });
    expect(report.genericNames).toEqual([{ name: "result", typeCount: 5, n: 10, types: RESULT_TYPES }]);
    expect(report.genericNameCount).toBe(1);
    // 7 tax + 23 billing + 3 web; generic, String, T and the untyped local are not evidence.
    expect(report.evidenceRows).toBe(33);
  });

  it("synonyms: a type whose names scatter, top name first, with counts, examples and evidence", async () => {
    const { synonyms } = await readReport(query({ sections: ["synonyms"] }));
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
    const { homonyms } = await readReport(query({ sections: ["homonyms"] }));
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
    const { outlierGroups } = await readReport(query({ sections: ["outliers"] }));
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
    const { collisions } = await readReport(query({ sections: ["collisions"] }));
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

  it("drops non-production files (scripts, test trees) from the summary and every section; src/ stays", async () => {
    // The set the architecture report excludes: tooling (`scripts/`, `spikes/`, …) and test shapes.
    await db.replaceIdentifiersBulk([
      {
        relPath: "scripts/spikes/probe.rb",
        rows: [
          // Generic in tooling only: five unrelated types.
          ...["A", "B", "C", "D", "E"].flatMap((t, i) => rows(2, typed("handle", `Type${t}`), 10 * (i + 1))),
          ...rows(4, typed("record", "Invoice"), 100),
        ],
      },
      {
        relPath: "scripts/report.rb",
        rows: [{ ownerSymbolId: "Report#render", kind: "local", name: "title", line: 3 }],
      },
      { relPath: "tests/billing_test.rb", rows: rows(5, typed("inv", "Invoice", "param"), 1) },
      { relPath: "src/billing/ledger.rb", rows: rows(2, typed("user", "User"), 1) },
    ]);

    const report = await readReport(query());

    expect(report.genericNames.map((g) => g.name)).toEqual(["result"]);
    // The fixture's 33 plus the two src/ rows; nothing under scripts/ or tests/.
    expect(report.evidenceRows).toBe(35);
    expect(report.homonyms?.[0].types.map((t) => [t.typeName, t.n])).toEqual([
      ["Invoice", 6],
      ["Payment", 3],
    ]);
    expect(report.collisions?.find((c) => c.rule === "shadowsMethod")?.n).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/"(scripts|tests)\//);
  });

  it("type groups split by multiplicity: `T[]` values and `T` values of one type are different groups", async () => {
    const many = (name: string) => ({ ...typed(name, "SymbolDefinition"), typeMultiplicity: "many" as const });
    await db.replaceIdentifiersBulk([
      {
        relPath: "src/resolve.ts",
        rows: [
          ...rows(3, many("candidates"), 1),
          ...rows(2, many("defs"), 10),
          ...rows(3, many("definitions"), 20),
          ...rows(4, typed("fallback", "SymbolDefinition"), 30),
          ...rows(2, typed("definition", "SymbolDefinition"), 40),
        ],
      },
    ]);
    const { synonyms } = await readReport(query({ sections: ["synonyms"], pathPrefixes: ["src/resolve"] }));
    expect(synonyms?.map((g) => [g.typeName, g.typeMultiplicity, g.n, g.names.map((n) => n.name)])).toEqual([
      ["SymbolDefinition", "many", 8, ["candidates", "definitions", "defs"]],
      ["SymbolDefinition", "one", 6, ["fallback", "definition"]],
    ]);
    expect(synonyms?.[0].evidence).toEqual({ binding: 8 });
  });

  it("`names` narrows the summary read to those names; their judgement is the unnarrowed one", async () => {
    const all = await db.readOntologyReportSummary(query());
    const asked = await db.readOntologyReportSummary(query({ names: ["result", "user"] }));
    expect(asked.genericNames).toEqual(all.genericNames);
    expect((await db.readOntologyReportSummary(query({ names: ["user"] }))).genericNames).toEqual([]);
  });

  it("scopes every section by rel_path prefix and by file extension", async () => {
    const byPrefix = await readReport(query({ pathPrefixes: ["app/services/tax"] }));
    expect(byPrefix.evidenceRows).toBe(7);
    expect(byPrefix.homonyms).toEqual([]);
    expect(byPrefix.synonyms?.map((s) => s.typeName)).toEqual(["TaxAutomationDocument"]);

    const rubyOnly = await readReport(query({ extensions: [".rb"] }));
    expect(rubyOnly.evidenceRows).toBe(30);
    expect(rubyOnly.homonyms?.[0].types.map((t) => [t.typeName, t.n])).toEqual([
      ["Invoice", 3],
      ["Payment", 3],
    ]);
  });

  it("judges generic names inside the scope: the summary and the sections' exclusion see the same rows", async () => {
    // `result` is generic project-wide (five types); under lib/one it is bound to one type.
    await db.replaceIdentifiersBulk([{ relPath: "lib/one/runner.rb", rows: rows(2, typed("result", "TypeA"), 1) }]);

    const outside = await readReport(query({ pathPrefixes: ["app/services/tax"] }));
    expect(outside.genericNames).toEqual([]);
    expect(outside.genericNameCount).toBe(0);

    const inside = await readReport(query({ pathPrefixes: ["lib/one"] }));
    expect(inside.genericNames).toEqual([]);
    // Not generic in scope, so its rows are evidence rather than dropped.
    expect(inside.evidenceRows).toBe(2);

    const genericScope = await readReport(query({ pathPrefixes: ["app/services/generic"] }));
    expect(genericScope.genericNames).toEqual([{ name: "result", typeCount: 5, n: 10, types: RESULT_TYPES }]);
    expect(genericScope.evidenceRows).toBe(0);

    const tsOnly = await readReport(query({ extensions: [".ts"] }));
    expect(tsOnly.genericNames).toEqual([]);
  });

  it("sections exclude exactly the names the caller passes, not the summary's generic candidates", async () => {
    // `form` over six `*Form` types and `actor` over five unrelated ones: both SQL candidates.
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/forms/signup.rb",
        rows: [
          ...rows(3, typed("form", "SignupForm"), 1),
          ...rows(1, typed("signup", "SignupForm"), 10),
          ...rows(1, typed("registration", "SignupForm"), 20),
          ...["ActionForm", "ClientForm", "InvoiceForm", "TaskForm"].flatMap((t, i) =>
            rows(2, typed("form", t), 100 + 10 * i),
          ),
        ],
      },
      {
        relPath: "app/actors/actor.rb",
        rows: [
          ...["Person", "Robot", "Queue", "Mailer", "Clock"].flatMap((t, i) =>
            rows(2, typed("actor", t), 10 * (i + 1)),
          ),
          ...rows(2, typed("person", "Person"), 100),
          ...rows(1, typed("human", "Person"), 110),
        ],
      },
    ]);
    const q = query({ pathPrefixes: ["app/forms", "app/actors"] });
    const summary = await db.readOntologyReportSummary(q);
    expect(summary.genericNames.map((g) => g.name)).toEqual(["form", "actor"]);

    const sections = await db.readOntologyReportSections(q, ["actor"]);
    // 11 form + 2 signup/registration + 3 person/human; the 10 actor rows are dropped.
    expect(sections.evidenceRows).toBe(16);
    const signup = sections.synonyms?.find((s) => s.typeName === "SignupForm");
    expect(signup?.names[0]).toMatchObject({ name: "form", n: 3 });
    expect(sections.synonyms?.map((s) => s.typeName)).not.toContain("Person");
    expect(sections.homonyms?.map((h) => h.name)).toContain("form");
    expect(sections.homonyms?.map((h) => h.name)).not.toContain("actor");

    const nothingExcluded = await db.readOntologyReportSections(q, []);
    expect(nothingExcluded.evidenceRows).toBe(26);
    expect(nothingExcluded.synonyms?.map((s) => s.typeName)).toContain("Person");
  });

  it("the summary read carries no sections and the sections read no summary", async () => {
    const summary = await db.readOntologyReportSummary(query());
    expect(Object.keys(summary).sort()).toEqual(["genericNameCount", "genericNames", "totals"]);
    const sections = await db.readOntologyReportSections(query({ sections: ["homonyms"] }), []);
    expect(Object.keys(sections).sort()).toEqual(["evidenceRows", "homonyms"]);
  });

  it("drops non-concept types only in the language that declares them", async () => {
    const report = await readReport(query({ nonConceptTypes: [{ extensions: [".ts"], typeNames: ["String"] }] }));
    // The Ruby String rows now count: label ×3 and title ×3 scatter over String.
    expect(report.synonyms?.map((s) => s.typeName)).toContain("String");
  });

  it("a non-concept group naming no extension or no type excludes nothing", async () => {
    const report = await readReport(
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
      readReport(query({ thresholds: { ...THRESHOLDS, synonymDominantShareCeiling: Number.NaN } })),
    ).rejects.toThrow(/non-finite threshold/);
  });

  it("reads only the requested sections", async () => {
    const report = await readReport(query({ sections: ["homonyms"] }));
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
    const { synonyms } = await readReport(query({ sections: ["synonyms"] }));
    const tax = synonyms?.find((s) => s.typeName === "TaxAutomationDocument");
    expect(tax?.n).toBe(8);
    expect(tax?.evidence).toEqual({ binding: 7, "call-return": 1 });
  });

  it("drops unused-marker params and locals (`_ctx`, `_user`) everywhere; fields and dunders stay", async () => {
    const at = (kind: IdentifierRow["kind"], name: string, typeName: string) => typed(name, typeName, kind);
    await db.replaceIdentifiersBulk([
      {
        relPath: "src/handlers.ts",
        rows: [
          ...rows(3, at("param", "_ctx", "RequestContext"), 1),
          ...rows(3, at("param", "_ctx", "JobContext"), 10),
          ...rows(4, at("local", "_relPath", "RelPath"), 20),
          ...rows(2, at("local", "relPath", "RelPath"), 30),
        ],
      },
      {
        relPath: "app/models/cache.py",
        rows: [
          ...rows(3, at("field", "_store", "Store"), 1),
          ...rows(3, at("field", "_store", "Backend"), 10),
          ...rows(3, at("local", "__entry__", "Entry"), 20),
          ...rows(3, at("local", "__entry__", "Slot"), 30),
        ],
      },
    ]);
    const report = await readReport(query());
    const homonymNames = report.homonyms?.map((h) => h.name) ?? [];
    expect(homonymNames).not.toContain("_ctx");
    expect(homonymNames).toContain("_store");
    expect(homonymNames).toContain("__entry__");
    const relPathNames = [...(report.synonyms ?? []), ...(report.outlierGroups ?? [])]
      .filter((g) => g.typeName === "RelPath")
      .flatMap((g) => g.names.map((n) => n.name));
    expect(relPathNames).not.toContain("_relPath");
  });

  it("reads homonym candidates up to groupPool, not limit — the ops layer filters before it caps", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/services/extra.rb",
        rows: [...rows(3, typed("entry", "Ledger"), 1), ...rows(3, typed("entry", "Journal"), 10)],
      },
    ]);
    const { homonyms } = await readReport(query({ sections: ["homonyms"], limit: 1 }));
    expect(homonyms?.map((h) => h.name).sort()).toEqual(["entry", "record"]);
  });

  it("reads every generic candidate uncapped, each with its types, for the ops layer to judge", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/forms/forms.rb",
        rows: ["ActionForm", "ClientForm", "InvoiceForm", "TaskForm", "UserForm", "Crm::ContactForm"].flatMap((t, i) =>
          rows(i === 0 ? 4 : 3, typed("form", t), 10 * (i + 1)),
        ),
      },
    ]);
    const report = await readReport(query({ limit: 1 }));
    expect(report.genericNames.map((g) => g.name)).toEqual(["form", "result"]);
    expect(report.genericNameCount).toBe(2);
    const [form] = report.genericNames;
    expect(form).toMatchObject({ name: "form", typeCount: 6, n: 19 });
    expect(form.types[0]).toEqual({ typeName: "ActionForm", n: 4, relPath: "app/forms/forms.rb" });
    expect(form.types.map((t) => t.typeName)).toEqual([
      "ActionForm",
      "ClientForm",
      "Crm::ContactForm",
      "InvoiceForm",
      "TaskForm",
      "UserForm",
    ]);
  });

  it("collisions: a SCREAMING constant is no type; a class, and an acronym class with members, still are", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/services/pricing.rb",
        rows: [
          ...rows(1, typed("group", "GettingPaid::PricingGroup"), 1),
          ...rows(1, typed("status", "GettingPaid::PricingGroup"), 2),
          ...rows(1, typed("connection", "Net::Socket"), 3),
          ...rows(1, typed("uri", "Web::Address"), 4),
          ...rows(1, typed("tag", "Label"), 5),
        ],
      },
    ]);
    const sym = (symbolId: string, relPath: string) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.split(/::|#|\./).pop() ?? symbolId,
      relPath,
      scope: [],
    });
    await db.upsertSymbols("app/models/pricing_group.rb", [
      sym("GettingPaid::PricingGroup", "app/models/pricing_group.rb"),
      sym("GettingPaid::PricingGroup::GROUP", "app/models/pricing_group.rb"),
      sym("GettingPaid::PricingGroup::STATUS", "app/models/pricing_group.rb"),
    ]);
    await db.upsertSymbols("app/models/connection.rb", [sym("Connection", "app/models/connection.rb")]);
    // Acronym class known by its member.
    await db.upsertSymbols("lib/uri.rb", [sym("URI", "lib/uri.rb"), sym("URI.parse", "lib/uri.rb")]);
    // Acronym class with no member, known by its inheritance edge.
    await db.upsertSymbols("lib/tag.rb", [sym("TAG", "lib/tag.rb")]);
    await db.run(
      `INSERT INTO cg_symbols_inheritance (source_fq_name, source_rel_path, ancestor_fq_name, kind, ordinal)
       VALUES ('TAG', 'lib/tag.rb', 'Base', 'superclass', 0)`,
    );
    // A class `Status` beside the constant `STATUS`: the collision names the class.
    await db.upsertSymbols("app/models/status.rb", [sym("Status", "app/models/status.rb")]);

    const { collisions } = await readReport(query({ sections: ["collisions"] }));
    const namesOtherType = (collisions ?? [])
      .filter((c) => c.rule === "namesOtherType")
      .map((c) => [c.name, c.symbol])
      .sort();
    expect(namesOtherType).toEqual([
      ["connection", "Connection"],
      ["invoice", "Invoice"],
      ["status", "Status"],
      ["tag", "TAG"],
      ["uri", "URI"],
    ]);
  });

  it("an empty table yields empty sections and zero counts", async () => {
    await db.run("DELETE FROM cg_identifiers");
    const report = await readReport(query());
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
