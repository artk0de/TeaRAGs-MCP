/**
 * NamingLexiconOps — the query behind `get_naming_lexicon`
 * (bd tea-rags-mcp-4p3sb.11).
 *
 * Runs against an in-process DuckDB holding `cg_identifiers`, method-edge and
 * `cg_symbols_files` rows shaped like the taxdome case the lexicon was built
 * for: `TaxAutomationDocument` values named `tax_automation_document` by
 * binding, by finder (`TaxAutomationDocument.find(id)`), through the return of
 * `find_tax_automation_document!` (call-return), and untyped namesakes the
 * name-inferred stage types. The explore side is a fake `semanticSearch`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { InputValidationError, InvalidParameterError } from "../../../../../src/core/api/errors.js";
import {
  NamingLexiconOps,
  type NamingLexiconExplore,
} from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import { ontologyLanguageProfiles } from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type { ExploreResponse, SemanticSearchRequest } from "../../../../../src/core/api/public/dto/index.js";
import type {
  IdentifierReplaceEntry,
  IdentifierRow,
  TypeDeclarationRow,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import { capability as javascriptCapability } from "../../../../../src/core/domains/language/javascript/capability.js";
import { capability as rubyCapability } from "../../../../../src/core/domains/language/ruby/capability.js";
import { capability as typescriptCapability } from "../../../../../src/core/domains/language/typescript/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const DOC = "TaxAutomationDocument";
const FINDER_FILE = "app/models/tax_automation_document.rb";
const FINDER_OWNER = "TaxAutomationDocument.find_tax_automation_document!";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["ruby", rubyCapability.naming as IdentifierNamingConvention],
  ["typescript", typescriptCapability.naming as IdentifierNamingConvention],
]);

function local(ownerSymbolId: string, name: string, extra: Partial<IdentifierRow> = {}): IdentifierRow {
  return { ownerSymbolId, kind: "local", name, line: 3, ...extra };
}

describe("NamingLexiconOps", () => {
  let dir: string;
  let db: DuckDbGraphClient;
  let semanticSearch: ReturnType<typeof vi.fn<(req: SemanticSearchRequest) => Promise<ExploreResponse>>>;
  let ops: NamingLexiconOps;

  async function write(entries: IdentifierReplaceEntry[], language = "ruby"): Promise<void> {
    await db.replaceIdentifiersBulk(entries);
    for (const { relPath } of entries) {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?) ON CONFLICT DO NOTHING", [
        relPath,
        language,
      ]);
    }
  }

  async function exactEdge(sourceRelPath: string, sourceSymbolId: string, callExpression: string): Promise<void> {
    await db.run(
      `INSERT INTO cg_symbols_edges_method
         (source_symbol_id, source_rel_path, target_rel_path, call_expression, target_symbol_key,
          target_symbol_id, edge_kind, confidence)
       VALUES (?, ?, ?, ?, ?, ?, 'exact', 1.0)`,
      [sourceSymbolId, sourceRelPath, FINDER_FILE, callExpression, FINDER_OWNER, FINDER_OWNER],
    );
  }

  /** The taxdome shape: 6 binding, 4 finder, 3 call-return, 2 untyped namesakes, 1 return row. */
  async function seedTaxdome(): Promise<void> {
    const service = (i: number) => `app/services/tax/sync_${i}.rb`;
    const entries: IdentifierReplaceEntry[] = [
      {
        relPath: FINDER_FILE,
        rows: [
          {
            ownerSymbolId: FINDER_OWNER,
            kind: "return",
            name: "find_tax_automation_document!",
            line: 10,
            typeName: DOC,
            typeSource: "return-type",
          },
        ],
      },
    ];
    for (let i = 0; i < 6; i++) {
      entries.push({
        relPath: service(i),
        rows: [local(`Sync${i}#call`, "tax_automation_document", { typeName: DOC, typeSource: "binding" })],
      });
    }
    for (let i = 0; i < 4; i++) {
      entries.push({
        relPath: `app/services/tax/finder_${i}.rb`,
        rows: [
          local(`Finder${i}#call`, "tax_automation_document", {
            typeName: DOC,
            typeSource: "finder",
            boundMember: "find",
            boundReceiver: DOC,
            boundCallExpression: `${DOC}.find(id)`,
          }),
        ],
      });
    }
    for (let i = 0; i < 3; i++) {
      entries.push({
        relPath: `app/services/tax/bang_${i}.rb`,
        rows: [
          local(`Bang${i}#call`, "tax_automation_document", {
            boundMember: "find_tax_automation_document!",
            boundCallExpression: "find_tax_automation_document!(id)",
          }),
        ],
      });
    }
    entries.push({
      relPath: "app/services/tax/deep/untyped.rb",
      rows: [local("Untyped#a", "tax_automation_document"), local("Untyped#b", "tax_automation_document")],
    });
    await write(entries);
    for (let i = 0; i < 3; i++) {
      await exactEdge(`app/services/tax/bang_${i}.rb`, `Bang${i}#call`, "find_tax_automation_document!(id)");
    }
  }

  function build(): NamingLexiconOps {
    // The ops closes its reader in `finally`; the fixture owns the connection.
    const graphDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "close") return async () => undefined;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return new NamingLexiconOps({
      pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (name: string) => name as never,
      explore: { semanticSearch },
      namingConventions: NAMING,
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-ops-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    semanticSearch = vi.fn(async () => ({ results: [], driftWarning: null }));
    ops = build();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("type mode", () => {
    beforeEach(seedTaxdome);

    it("names per kind with shapes, confidence and evidence per type source — name-inferred counted apart", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", types: [DOC], language: "ruby" });

      expect(result.scope).toBe("");
      expect(result.language).toBe("ruby");
      expect(result.byType).toHaveLength(1);
      const [entry] = result.byType;
      expect(entry.type).toBe(DOC);
      expect(entry.kinds.local).toEqual([{ name: "tax_automation_document", n: 15 }]);
      expect(entry.kinds.return).toEqual([{ name: "find_tax_automation_document!", n: 1 }]);
      expect(entry.shapes.local).toEqual([{ shape: "EXACT", share: 1 }]);
      expect(entry.shapes.return).toEqual([{ shape: "VERB_TYPE", share: 1 }]);
      expect(entry.evidence).toEqual({
        binding: 6,
        finder: 4,
        "call-return": 3,
        "name-inferred": 2,
        "return-type": 1,
      });
      expect(entry.confidence).toBeCloseTo((16 / 20) ** 2);
    });

    it("anchors add the typed params / returns of the given symbols to the types", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", anchors: [FINDER_OWNER], language: "ruby" });
      expect(result.byType.map((e) => e.type)).toEqual([DOC]);
    });

    it("excludes the language's non-concept types from byType", async () => {
      await write([
        { relPath: "app/x.rb", rows: [local("X#a", "name", { typeName: "String", typeSource: "binding" })] },
      ]);
      const result = await ops.getNamingLexicon({ collection: "c", types: ["String", DOC], language: "ruby" });
      expect(result.byType.map((e) => e.type)).toEqual([DOC]);
    });

    it("infers the language from the scope's dominant file language when none is given", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", types: [DOC] });
      expect(result.language).toBe("ruby");
      expect(result.byType[0].shapes.local).toEqual([{ shape: "EXACT", share: 1 }]);
    });

    it("widens a scope under 5 supporting rows to the parent directory and reports the scope used", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        types: [DOC],
        language: "ruby",
        pathPattern: "app/services/tax/deep/**",
      });
      expect(result.scope).toBe("app/services/tax/");
      // the finder's own return row lives outside the widened scope
      expect(result.byType[0].kinds.return).toBeUndefined();
    });

    it("keeps a scope that already holds 5 supporting rows", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        types: [DOC],
        language: "ruby",
        pathPattern: "app/services/**/*.rb",
      });
      expect(result.scope).toBe("app/services/");
    });
  });

  describe("draft names — the taxdome case end to end", () => {
    beforeEach(seedTaxdome);

    it("`row` bound from find_tax_automation_document! → MISFIT suggesting tax_automation_document", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "row", kind: "local", callee: { member: "find_tax_automation_document!" } }],
      });
      expect(result.names).toEqual([
        {
          name: "row",
          verdict: "MISFIT",
          suggestion: "tax_automation_document",
          holder: "Bang0#call",
          evidence: { n: 0, example: "Bang0#call", boundTypes: 0, collision: false },
        },
      ]);
      expect(result.byCallee).toEqual([
        {
          member: "find_tax_automation_document!",
          kinds: { local: [{ name: "tax_automation_document", n: 3 }] },
          shapes: { local: [{ shape: "CALLEE_DERIVED", share: 1 }] },
        },
      ]);
    });

    it("`row = TaxAutomationDocument.find(id)` → MISFIT through the finder rows", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "row", callee: { member: "find", receiver: DOC } }],
      });
      expect(result.names[0]).toMatchObject({ verdict: "MISFIT", suggestion: "tax_automation_document" });
    });

    it("a typed draft is judged against the type's rows; the observed name conforms", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [
          { name: "row", kind: "local", type: DOC },
          { name: "tax_automation_document", kind: "local", type: DOC },
        ],
      });
      expect(result.names[0]).toMatchObject({ verdict: "MISFIT", suggestion: "tax_automation_document" });
      expect(result.names[1]).toMatchObject({
        verdict: "CONFORMS",
        evidence: { n: 15, boundTypes: 1, collision: false },
      });
    });

    it("asked types and an untyped callee-bound draft together: byType and byCallee both answer", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        types: [DOC],
        names: [{ name: "row", kind: "local", callee: { member: "find_tax_automation_document!" } }],
      });
      expect(result.byType.map((e) => e.type)).toEqual([DOC]);
      expect(result.byCallee).toEqual([
        {
          member: "find_tax_automation_document!",
          kinds: { local: [{ name: "tax_automation_document", n: 3 }] },
          shapes: { local: [{ shape: "CALLEE_DERIVED", share: 1 }] },
        },
      ]);
      expect(result.names[0]).toMatchObject({ verdict: "MISFIT", suggestion: "tax_automation_document" });
    });
  });

  describe("project prior licenses the callee-derived fallback", () => {
    async function seedLocals(namer: (i: number) => string): Promise<void> {
      const rows: IdentifierRow[] = [];
      for (let i = 0; i < 30; i++) rows.push(local(`S#m${i}`, namer(i), { boundMember: `find_thing_${i}!` }));
      await write([{ relPath: "app/s.rb", rows }]);
    }
    const draft = { name: "row", kind: "local" as const, callee: { member: "find_widget!" } };

    it("a FREE-dominant project → no forced suggestion", async () => {
      await seedLocals((i) => `row_${String.fromCharCode(97 + (i % 26))}`);
      const result = await ops.getNamingLexicon({ collection: "c", language: "ruby", names: [draft] });
      expect(result.names[0]).toMatchObject({ verdict: "NEW_TERM", topTerms: [] });
      expect(result.names[0]).not.toHaveProperty("suggestion");
    });

    it("a CALLEE_DERIVED-dominant project → the callee-derived suggestion", async () => {
      await seedLocals((i) => `thing_${i}`);
      const result = await ops.getNamingLexicon({ collection: "c", language: "ruby", names: [draft] });
      expect(result.names[0]).toMatchObject({ verdict: "MISFIT", suggestion: "widget" });
    });
  });

  describe("concept mode", () => {
    beforeEach(seedTaxdome);

    const holder = (symbolId: string, relativePath: string, score: number) => ({
      id: symbolId,
      score,
      payload: { symbolId, relativePath },
    });

    it("searches the concept alone with the spec's parameters under the L2 domain and extracts terms", async () => {
      semanticSearch.mockResolvedValue({
        driftWarning: null,
        results: [1, 2, 3, 4, 5].map((i) =>
          holder(`TaxPreparation::TaxAutomations::Document#sync_${i}`, "app/services/tax_automations/document.rb", 1),
        ),
      });
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        concept: "tax automation document sync",
        pathPattern: "app/services/tax/**",
        names: [{ name: "VendorEnvelopeSyncer" }],
      });

      expect(semanticSearch).toHaveBeenCalledTimes(1);
      expect(semanticSearch).toHaveBeenCalledWith({
        collection: "c",
        query: "tax automation document sync",
        language: "ruby",
        pathPattern: "app/services/**",
        filter: { presets: "production" },
        rerank: { custom: { similarity: 0.7, chunkFanIn: 0.15, fanIn: 0.15 } },
        limit: 30,
        metaOnly: true,
        fields: ["symbolId", "relativePath", "parentSymbolId"],
      });
      expect(result.concept?.terms.map((t) => t.term)).toContain("tax_automation");
      expect(result.names[0]).toMatchObject({ verdict: "NEW_TERM" });
    });

    it("widens to the project when the L2 domain yields under 5 holders", async () => {
      semanticSearch.mockResolvedValueOnce({ driftWarning: null, results: [holder("A#b", "app/a.rb", 1)] });
      await ops.getNamingLexicon({ collection: "c", language: "ruby", concept: "x", pathPattern: "app/services/**" });
      expect(semanticSearch).toHaveBeenCalledTimes(2);
      expect(semanticSearch.mock.calls[1][0]).not.toHaveProperty("pathPattern");
    });

    it("skips the concept step with a notice when the search throws, and still answers the rest", async () => {
      semanticSearch.mockRejectedValue(new Error("ollama unreachable"));
      const result = await ops.getNamingLexicon({ collection: "c", language: "ruby", concept: "x", types: [DOC] });
      expect(result.concept).toBeUndefined();
      expect(result.notices).toEqual(["concept step skipped: ollama unreachable"]);
      expect(result.byType).toHaveLength(1);
    });
  });

  describe("validation and failure modes", () => {
    it("rejects a request with none of types / anchors / concept / names", async () => {
      await expect(ops.getNamingLexicon({ collection: "c" })).rejects.toBeInstanceOf(InputValidationError);
      await expect(ops.getNamingLexicon({ collection: "c", types: [], names: [] })).rejects.toBeInstanceOf(
        InputValidationError,
      );
    });

    it("rejects a concept without a language", async () => {
      await expect(ops.getNamingLexicon({ collection: "c", concept: "x" })).rejects.toBeInstanceOf(
        InputValidationError,
      );
    });

    it("an index with a graph but an empty identifier table → driftWarning naming the reindex", async () => {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES ('a.rb', 'ruby')");
      const result = await ops.getNamingLexicon({ collection: "c", types: [DOC], language: "ruby" });
      expect(result.driftWarning).toMatch(/reindex/);
      expect(result.byType).toEqual([]);
    });

    it("no driftWarning when the table holds rows but not for the asked type", async () => {
      await seedTaxdome();
      const result = await ops.getNamingLexicon({ collection: "c", types: ["Unknown"], language: "ruby" });
      expect(result.driftWarning).toBeUndefined();
      expect(result.byType).toEqual([]);
    });

    it("an unreachable codegraph store → an empty answer with a notice", async () => {
      const unreachable = new NamingLexiconOps({
        pool: { acquireReader: vi.fn(async () => Promise.reject(new Error("daemon down"))) },
        collectionRegistry: {} as never,
        explore: { semanticSearch },
        namingConventions: NAMING,
      });
      expect(await unreachable.getNamingLexicon({ collection: "c", types: [DOC] })).toEqual({
        scope: "",
        byType: [],
        names: [],
        notices: ["codegraph store unavailable: daemon down"],
      });
    });

    it("a language with no descriptor → casing from the observed names", async () => {
      const rows: IdentifierRow[] = [];
      for (let i = 0; i < 5; i++) {
        rows.push(local(`K${i}#run`, "taxDocument", { typeName: "TaxDocument", typeSource: "annotation" }));
      }
      await write([{ relPath: "src/k.kt", rows }], "kotlin");
      const result = await ops.getNamingLexicon({ collection: "c", types: ["TaxDocument"] });
      expect(result.language).toBe("kotlin");
      expect(result.byType[0].shapes.local).toEqual([{ shape: "EXACT", share: 1 }]);
    });

    it("an input error from the concept search propagates instead of degrading to a notice", async () => {
      await seedTaxdome();
      semanticSearch.mockRejectedValue(new InvalidParameterError("pathPattern", "malformed glob"));
      await expect(
        ops.getNamingLexicon({ collection: "c", language: "ruby", concept: "x", types: [DOC] }),
      ).rejects.toBeInstanceOf(InvalidParameterError);
    });

    it("an alias that fails to resolve reads the physical name; a failing reader close never masks the answer", async () => {
      await seedTaxdome();
      const graphDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "close") return async () => Promise.reject(new Error("already closed"));
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const acquireReader = vi.fn(async () => ({ graphDb, symbolTable: {} }));
      const resilient = new NamingLexiconOps({
        pool: { acquireReader } as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async () => Promise.reject(new Error("registry offline")),
        explore: { semanticSearch },
        namingConventions: NAMING,
      });
      const result = await resilient.getNamingLexicon({ collection: "c", types: [DOC], language: "ruby" });
      expect(acquireReader).toHaveBeenCalledWith("c");
      expect(result.byType.map((e) => e.type)).toEqual([DOC]);
    });
  });

  describe("several types in one answer", () => {
    /** Invoice: 4 × invoice + 2 × inv locals and an `amount` return; Payment: 2 × payment. */
    async function seedLedger(): Promise<void> {
      const typed = (owner: string, name: string, typeName: string) =>
        local(owner, name, { typeName, typeSource: "binding" });
      const rows: IdentifierRow[] = [
        ...[0, 1, 2, 3].map((i) => typed(`A${i}#run`, "invoice", "Invoice")),
        ...[0, 1].map((i) => typed(`B${i}#run`, "inv", "Invoice")),
        ...[0, 1].map((i) => typed(`C${i}#run`, "payment", "Payment")),
      ];
      rows.push({
        ownerSymbolId: "Ledger#amount",
        kind: "return",
        name: "amount",
        line: 9,
        typeName: "Invoice",
        typeSource: "return-type",
      });
      await write([{ relPath: "app/ledger.rb", rows }]);
    }

    it("orders types by evidence, names within a kind by count, and judges a typed draft against its own type only", async () => {
      await seedLedger();
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        types: ["Payment", "Invoice"],
        names: [{ name: "inv", kind: "local", type: "Invoice" }],
      });

      expect(result.byType.map((e) => e.type)).toEqual(["Invoice", "Payment"]);
      expect(result.byType[0].kinds.local).toEqual([
        { name: "invoice", n: 4 },
        { name: "inv", n: 2 },
      ]);
      expect(result.byType[0].kinds.return).toEqual([{ name: "amount", n: 1 }]);
      expect(result.byType[1].kinds.local).toEqual([{ name: "payment", n: 2 }]);
      expect(result.names).toHaveLength(1);
      expect(result.names[0]).toMatchObject({ name: "inv", evidence: { n: 2, boundTypes: 1, collision: false } });
    });

    it("name-inferred lends only an asked type held by ≥ 80% of ≥ 3 typed rows", async () => {
      const rows: IdentifierRow[] = [
        // `doc`: typed Draft 4×, Invoice 1× → Draft dominates, but Draft was not asked.
        ...[0, 1, 2, 3].map((i) => local(`D${i}#run`, "doc", { typeName: "Draft", typeSource: "binding" })),
        local("E0#run", "doc", { typeName: "Invoice", typeSource: "binding" }),
        local("F0#run", "doc"),
        // `memo`: one typed row — too little evidence to lend its type.
        local("G0#run", "memo", { typeName: "Invoice", typeSource: "binding" }),
        local("H0#run", "memo"),
      ];
      await write([{ relPath: "app/docs.rb", rows }]);

      const result = await ops.getNamingLexicon({ collection: "c", language: "ruby", types: ["Invoice"] });

      expect(result.byType).toHaveLength(1);
      expect(result.byType[0].evidence).toEqual({ binding: 2 });
      expect(result.byType[0].kinds.local).toEqual([
        { name: "doc", n: 1 },
        { name: "memo", n: 1 },
      ]);
    });

    // Live tea-rags: `StatsCache` evidence read `"constructor": "function Object() { [native code] }1"`
    // — the `constructor` type source collided with Object.prototype.constructor.
    it("counts the `constructor` type source as a number, not Object.prototype.constructor", async () => {
      await write([
        {
          relPath: "app/cache.rb",
          rows: [
            local("A0#run", "cache", { typeName: "Cache", typeSource: "constructor" }),
            local("A1#run", "cache", { typeName: "Cache", typeSource: "binding" }),
          ],
        },
      ]);

      const result = await ops.getNamingLexicon({ collection: "c", language: "ruby", types: ["Cache"] });

      expect(result.byType[0].evidence).toEqual({ constructor: 1, binding: 1 });
    });
  });

  // Live taxdome (Ruby + TypeScript): `app/**/*.rb` with a callee that has no
  // rows widened to the project and took the project's dominant language —
  // TypeScript — so Ruby drafts were judged in TypeScript casing.
  describe("language is decided by the REQUESTED pattern, not the widened scope", () => {
    beforeEach(async () => {
      const tsRows = (i: number) => [0, 1, 2, 3].map((j) => local(`Widget${i}#render${j}`, "vendorEnvelope"));
      await write(
        [0, 1, 2, 3, 4].map((i) => ({ relPath: `app/javascript/widget_${i}.ts`, rows: tsRows(i) })),
        "typescript",
      );
      await write([
        { relPath: "app/models/vendor.rb", rows: [local("Vendor#load", "vendor_envelope")] },
        { relPath: "app/models/envelope.rb", rows: [local("Envelope#load", "envelope")] },
      ]);
    });

    const draft = { name: "row", callee: { member: "find_vendor_envelope" } };

    it("`app/**/*.rb` → ruby while the evidence scope widens to the project", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", pathPattern: "app/**/*.rb", names: [draft] });
      expect(result.scope).toBe("");
      expect(result.language).toBe("ruby");
    });

    it("a braced extension list restricts the counts to every listed suffix", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        pathPattern: "app/**/*.{rb,rake}",
        names: [draft],
      });
      expect(result.language).toBe("ruby");
    });

    it("a requested prefix with no rows keeps the pinned extension over the project's dominant language", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", pathPattern: "lib/**/*.rb", names: [draft] });
      expect(result.language).toBe("ruby");
    });

    it("a requested scope with no identifier rows at all falls back to the project counts", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", pathPattern: "vendor/**", names: [draft] });
      expect(result.language).toBe("typescript");
    });

    it("without an extension the requested prefix still decides", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", pathPattern: "app/models/**", names: [draft] });
      expect(result.scope).toBe("");
      expect(result.language).toBe("ruby");
    });
  });

  // Live taxdome: `types: ["TaxAutomationDocument"]` with no language and no
  // pathPattern answered in the project's dominant language (TypeScript) and
  // judged the Ruby rows in camelCase — `tax_automation_documents` came out FREE.
  describe("evidence rows are cased in their own file language", () => {
    beforeEach(async () => {
      const tsRows = (i: number) => [0, 1, 2, 3].map((j) => local(`Widget${i}#render${j}`, "vendorEnvelope"));
      await write(
        [0, 1, 2, 3, 4].map((i) => ({ relPath: `app/javascript/widget_${i}.ts`, rows: tsRows(i) })),
        "typescript",
      );
    });

    it("a type whose rows are all Ruby answers in ruby, its snake_case rows EXACT", async () => {
      await write([
        {
          relPath: "app/models/firm.rb",
          rows: [
            {
              ownerSymbolId: "Firm#tax_automation_documents",
              kind: "return",
              name: "tax_automation_documents",
              line: 4,
              typeName: DOC,
              typeSource: "return-type",
            },
            local("Firm#sync", "tax_automation_document", { typeName: DOC, typeSource: "binding" }),
          ],
        },
      ]);
      const result = await ops.getNamingLexicon({ collection: "c", types: [DOC] });
      expect(result.language).toBe("ruby");
      expect(result.byType[0].shapes.return).toEqual([{ shape: "EXACT", share: 1 }]);
      expect(result.byType[0].shapes.local).toEqual([{ shape: "EXACT", share: 1 }]);
    });

    it("one type with a TypeScript and a Ruby row: each is EXACT in its own casing", async () => {
      await write(
        [
          {
            relPath: "app/javascript/doc_panel.ts",
            rows: [local("DocPanel#render", "taxAutomationDocument", { typeName: DOC, typeSource: "annotation" })],
          },
        ],
        "typescript",
      );
      await write([
        {
          relPath: "app/services/doc_sync.rb",
          rows: [local("DocSync#call", "tax_automation_document", { typeName: DOC, typeSource: "binding" })],
        },
      ]);
      const result = await ops.getNamingLexicon({ collection: "c", types: [DOC] });
      expect(result.byType[0].shapes.local).toEqual([{ shape: "EXACT", share: 1 }]);
    });

    it("a Ruby draft typed with a Ruby-only type is judged in ruby casing", async () => {
      await write([
        {
          relPath: "app/services/doc_sync.rb",
          rows: [0, 1, 2].map((i) =>
            local(`DocSync${i}#call`, "tax_automation_document", { typeName: DOC, typeSource: "binding" }),
          ),
        },
      ]);
      const result = await ops.getNamingLexicon({
        collection: "c",
        names: [{ name: "tax_automation_document", type: DOC }],
      });
      expect(result.language).toBe("ruby");
      expect(result.names[0].verdict).toBe("CONFORMS");
    });
  });

  describe("T vs T[]: a draft is judged against rows of its own multiplicity (bd tea-rags-mcp-4p3sb.26)", () => {
    beforeEach(async () => {
      // `Item[]` values are named `items`; single `Item` values `record`.
      await write(
        [
          {
            relPath: "src/cart.ts",
            rows: [
              ...[0, 1, 2, 3, 4].map((i) =>
                local(`Cart${i}#load`, "items", {
                  typeName: "Item",
                  typeSource: "annotation",
                  typeMultiplicity: "many",
                  line: i + 1,
                }),
              ),
              ...[0, 1, 2, 3].map((i) =>
                local(`Cart${i}#pick`, "record", { typeName: "Item", typeSource: "annotation", line: 20 + i }),
              ),
            ],
          },
        ],
        "typescript",
      );
    });

    it("`items: Item[]` conforms, `item: Item[]` is a MISFIT naming `items`", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "typescript",
        names: [
          { name: "items", type: "Item", typeMultiplicity: "many" },
          { name: "item", type: "Item", typeMultiplicity: "many" },
        ],
      });
      expect(result.names[0]).toMatchObject({ name: "items", verdict: "CONFORMS" });
      expect(result.names[1]).toMatchObject({ name: "item", verdict: "MISFIT", suggestion: "items" });
    });

    it("a single-value draft is judged against the single-value rows only", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "typescript",
        names: [{ name: "items", type: "Item" }],
      });
      // Against the collection rows `items` would conform; the single values are named `record`.
      expect(result.names[0]).toMatchObject({ verdict: "MISFIT", suggestion: "record" });
    });
  });

  describe("QUALIFIED is a second binding of the type in the same owner (bd tea-rags-mcp-1hj3o)", () => {
    beforeEach(async () => {
      const node = { typeName: "Node", typeSource: "annotation" as const };
      await write(
        [
          {
            relPath: "src/graph.ts",
            rows: [
              ...[0, 1, 2, 3, 4, 5].map((i) => local(`Graph${i}#walk`, "node", { ...node, line: i + 1 })),
              // `sourceNode` beside the param `node`: a confirmed qualifier.
              ...[0, 1, 2].flatMap((i) => [
                { ...local(`Graph${i}#link`, "node", { ...node, line: 20 + i }), kind: "param" as const },
                local(`Graph${i}#link`, "sourceNode", { ...node, line: 30 + i }),
              ]),
              // `resultNode` alone in its owner: an arbitrary prefix, a role name.
              ...[0, 1, 2].map((i) => local(`Graph${i}#find`, "resultNode", { ...node, line: 40 + i })),
            ],
          },
        ],
        "typescript",
      );
    });

    it("byType counts a qualified local as QUALIFIED only beside a second Node, FREE otherwise", async () => {
      const result = await ops.getNamingLexicon({ collection: "c", language: "typescript", types: ["Node"] });
      expect(result.byType[0].shapes.local).toEqual([
        { shape: "EXACT", share: 0.5 },
        { shape: "QUALIFIED", share: 0.25 },
        { shape: "FREE", share: 0.25 },
      ]);
    });

    it("a known lone qualifier conforms; a novel FREE local is a NEW_TERM with the type's names", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "typescript",
        names: [
          { name: "resultNode", type: "Node" },
          { name: "targetNode", type: "Node" },
          { name: "x", type: "Node" },
        ],
      });
      expect(result.names[0]).toMatchObject({ name: "resultNode", verdict: "CONFORMS" });
      expect(result.names[1]).toMatchObject({ name: "targetNode", verdict: "CONFORMS" });
      expect(result.names[2]).toMatchObject({
        name: "x",
        verdict: "NEW_TERM",
        topTerms: ["node", "resultNode", "sourceNode"],
      });
    });
  });

  describe("a draft named with a judged generic name carries a caveat", () => {
    function buildWithOntology(): NamingLexiconOps {
      const graphDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "close") return async () => undefined;
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      return new NamingLexiconOps({
        pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async (name: string) => name as never,
        explore: { semanticSearch },
        namingConventions: NAMING,
        ontologyLanguages: ontologyLanguageProfiles(),
      });
    }

    beforeEach(async () => {
      // `result` is bound to six unrelated types — generic, as get_ontology_report judges it —
      // and six times to RunReport, so a `result: RunReport` draft conforms by type.
      await write([
        {
          relPath: "app/services/runner.rb",
          rows: [
            ...["TypeA", "TypeB", "TypeC", "TypeD", "TypeE"].flatMap((typeName, i) =>
              [0, 1].map((j) => local(`Run${i}#call`, "result", { typeName, typeSource: "binding", line: 10 * i + j })),
            ),
            ...[0, 1, 2, 3, 4, 5].map((i) =>
              local(`Report${i}#call`, "result", { typeName: "RunReport", typeSource: "binding", line: 100 + i }),
            ),
            ...[0, 1, 2].map((i) =>
              local(`Report${i}#call`, "run_report", { typeName: "RunReport", typeSource: "binding", line: 200 + i }),
            ),
          ],
        },
      ]);
    });

    it("CONFORMS by type, with `genericName` saying how many unrelated types share the name", async () => {
      const result = await buildWithOntology().getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [
          { name: "result", type: "RunReport" },
          { name: "run_report", type: "RunReport" },
        ],
      });
      expect(result.names[0]).toMatchObject({
        name: "result",
        verdict: "CONFORMS",
        genericName: { typeCount: 6, n: 16 },
      });
      expect(result.names[1]).toMatchObject({ name: "run_report", verdict: "CONFORMS" });
      expect(result.names[1]).not.toHaveProperty("genericName");
    });

    it("reads the generic judgement for the drafts' names only", async () => {
      const summary = vi.spyOn(db, "readOntologyReportSummary");
      await buildWithOntology().getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "result", type: "RunReport" }],
      });
      expect(summary).toHaveBeenCalledTimes(1);
      expect(summary.mock.calls[0][0].names).toEqual(["result"]);
    });
  });

  // bd tea-rags-mcp-vi0wx (spec §3–4): type and constant drafts judged against cg_type_declarations.
  describe("type drafts — roles, collisions and term alignment", () => {
    const decl = (typeId: string, symbolKind: TypeDeclarationRow["symbolKind"], supertypes: string[] = []) => ({
      language: "typescript",
      typeId,
      shortName: typeId,
      symbolKind,
      line: 1,
      reopens: false,
      supertypes,
    });
    const holder = (symbolId: string, relativePath: string) => ({
      id: symbolId,
      score: 1,
      payload: { symbolId, relativePath },
    });

    beforeEach(async () => {
      const fillers = Array.from({ length: 20 }, (_, i) => ({
        relPath: `src/f${i}/x.ts`,
        rows: [decl(`Filler${String.fromCharCode(97 + i)}`, "class")],
      }));
      await db.replaceTypeDeclarationsBulk([
        ...fillers,
        { relPath: "src/lang/ts/strategy.ts", rows: [decl("TsStrategy", "class", ["SymbolResolutionStrategy"])] },
        { relPath: "src/lang/py/strategy.ts", rows: [decl("PyStrategy", "class", ["SymbolResolutionStrategy"])] },
        { relPath: "src/git/commit.ts", rows: [decl("Commit", "class")] },
        { relPath: "src/templates/predefined.ts", rows: [decl("PredefinedTemplate", "class")] },
        { relPath: "src/fields/predefined.ts", rows: [decl("PredefinedField", "class")] },
        // One constant per file: a directory role counts files, not declarations.
        { relPath: "src/infra/spec-patterns.ts", rows: [decl("SPEC_PATTERN", "constant")] },
        { relPath: "src/infra/test-patterns.ts", rows: [decl("TEST_PATTERN", "constant")] },
        { relPath: "src/infra/fixture-patterns.ts", rows: [decl("FIXTURE_PATTERN", "constant")] },
      ]);
    });

    it("judges each draft by its population: MISFIT by family, COLLISION, a constant by its directory", async () => {
      const result = await ops.getNamingLexicon({
        collection: "c",
        names: [
          {
            name: "ResolutionOutcome",
            kind: "type",
            path: "src/core/domains/language/x/strategies/new.ts",
            extends: "SymbolResolutionStrategy",
          },
          { name: "Commit", kind: "type", path: "src/vcs/commit.ts" },
          { name: "VENDOR_GLOB", kind: "type", path: "src/infra/patterns.ts" },
        ],
      });
      expect(result.names).toEqual([
        expect.objectContaining({
          name: "ResolutionOutcome",
          verdict: "MISFIT",
          suggestion: "ResolutionOutcomeStrategy",
        }),
        expect.objectContaining({
          name: "Commit",
          verdict: "COLLISION",
          existing: { symbolId: "Commit", relPath: "src/git/commit.ts" },
        }),
        expect.objectContaining({ name: "VENDOR_GLOB", verdict: "MISFIT", suggestion: "VENDOR_GLOB_PATTERN" }),
      ]);
    });

    it("aligns terms through a concept search of the draft's own words; nothing found is a plain NEW_TERM", async () => {
      semanticSearch.mockResolvedValueOnce({
        driftWarning: null,
        results: [
          holder("PredefinedTemplate#render", "src/templates/predefined.ts"),
          holder("PredefinedField#value", "src/fields/predefined.ts"),
        ],
      });
      const aligned = await ops.getNamingLexicon({
        collection: "c",
        names: [{ name: "CalculatedDoc", kind: "type", path: "src/docs/calculated.ts" }],
      });
      expect(semanticSearch).toHaveBeenCalledWith(expect.objectContaining({ query: "calculated doc" }));
      expect(aligned.names[0]).toMatchObject({ verdict: "NEW_TERM", alternatives: [{ word: "predefined" }] });

      const novel = await ops.getNamingLexicon({
        collection: "c",
        names: [{ name: "CalculatedDoc", kind: "type", path: "src/docs/calculated.ts", concept: "billing math" }],
      });
      expect(semanticSearch).toHaveBeenLastCalledWith(expect.objectContaining({ query: "billing math" }));
      expect(novel.names[0]).toMatchObject({ verdict: "NEW_TERM", topTerms: [] });
      expect(novel.names[0]).not.toHaveProperty("alternatives");
    });

    it("a failing alignment search is a notice, and the draft is still judged", async () => {
      semanticSearch.mockRejectedValue(new Error("ollama unreachable"));
      const result = await ops.getNamingLexicon({
        collection: "c",
        names: [{ name: "Commit", kind: "type", path: "src/vcs/commit.ts" }],
      });
      expect(result.names[0]).toMatchObject({ verdict: "COLLISION" });
      expect(result.notices).toEqual(["type-name alignment skipped: ollama unreachable"]);
    });

    // bd tea-rags-mcp-433d2: a synonym head is aligned by the embedding of short head words.
    describe("head alignment by meaning", () => {
      // `numbers`, `figures` and `metrics` share one direction; every other word is its own axis,
      // so the project's null head pairs score 0 and the floor is 0.
      const SHARED = ["numbers", "figures", "metrics"];
      const DIMENSIONS = 64;
      let axes: Map<string, number>;
      const vectorOf = (word: string): number[] => {
        const vector = new Array<number>(DIMENSIONS).fill(0);
        if (SHARED.includes(word)) vector[0] = 1;
        else vector[(axes.get(word) ?? axes.set(word, axes.size + 1).get(word)) as number] = 1;
        return vector;
      };
      /** Ten more heads, two carriers each: a null population large enough to measure. */
      const NULL_HEADS = ["Anchor", "Beacon", "Cable", "Dagger", "Ember", "Falcon", "Glacier", "Harbor"];
      let embedBatch: ReturnType<typeof vi.fn<(texts: string[]) => Promise<{ embedding: number[] }[]>>>;

      function buildWithEmbeddings(explore?: NamingLexiconExplore): NamingLexiconOps {
        const graphDb = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === "close") return async () => undefined;
            const value: unknown = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        return new NamingLexiconOps({
          pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
          collectionRegistry: {} as never,
          resolveActiveCollection: async (name: string) => name as never,
          explore: explore ?? { semanticSearch },
          namingConventions: NAMING,
          ontologyLanguages: ontologyLanguageProfiles(),
          embeddings: { embedBatch },
        });
      }

      beforeEach(async () => {
        // A word and its `class <word>` form embed alike here: one vector per word.
        axes = new Map();
        embedBatch = vi.fn(async (texts: string[]) =>
          texts.map((t) => ({ embedding: vectorOf(t.replace(/^class /, "")) })),
        );
        // The concept code of both drafts holds `IndexMetrics`: the candidate is grounded.
        semanticSearch.mockResolvedValue({
          driftWarning: null,
          results: [holder("IndexMetrics#total", "src/dto/metrics.ts")],
        });
        await db.replaceTypeDeclarationsBulk([
          { relPath: "src/dto/metrics.ts", rows: [decl("IndexMetrics", "interface")] },
          { relPath: "src/signals/metrics.ts", rows: [decl("SignalMetrics", "interface")] },
          { relPath: "src/dto/status.ts", rows: [decl("IndexStatus", "interface")] },
          { relPath: "src/run/status.ts", rows: [decl("RunStatus", "interface")] },
          ...NULL_HEADS.flatMap((head) =>
            ["Left", "Right"].map((side) => ({
              relPath: `src/${head.toLowerCase()}/${side.toLowerCase()}.ts`,
              rows: [decl(`${side}${head}`, "class")],
            })),
          ),
        ]);
      });

      it("embeds the null head sample ONCE per request, then each draft's missing words in ONE batch", async () => {
        const result = await buildWithEmbeddings().getNamingLexicon({
          collection: "c",
          names: [
            { name: "IndexNumbers", kind: "type", path: "src/api/numbers.ts" },
            { name: "IndexFigures", kind: "type", path: "src/api/figures.ts" },
          ],
        });
        expect(embedBatch).toHaveBeenCalledTimes(3);
        // The null sample: the project's heads carried by ≥ 2 types, in both encodings.
        expect(embedBatch.mock.calls[0][0]).toEqual(
          expect.arrayContaining(["metrics", "class metrics", "status", "anchor", "class harbor", "strategy"]),
        );
        // Per draft only what the request has not embedded yet: `metrics` is reused from the null sample,
        // and `status` (IndexStatus) is not grounded in the concept code.
        expect(embedBatch.mock.calls[1][0]).toEqual(["numbers", "class numbers"]);
        expect(embedBatch.mock.calls[2][0]).toEqual(["figures", "class figures"]);
        expect(result.names[0]).toMatchObject({
          verdict: "NEW_TERM",
          alternatives: [{ word: "metrics", slot: "head", examples: ["IndexMetrics"] }],
        });
        expect(result.names[1]).toMatchObject({ alternatives: [{ word: "metrics", slot: "head" }] });
        expect(result.notices).toBeUndefined();
      });

      describe("a head ONE type carries, established by usage", () => {
        // `IndexTally` is the only `*Tally`; three files import it.
        beforeEach(async () => {
          SHARED.push("tally");
          await db.replaceTypeDeclarationsBulk([{ relPath: "src/dto/tally.ts", rows: [decl("IndexTally", "class")] }]);
          for (const source of ["src/a.ts", "src/b.ts", "src/c.ts"]) {
            await db.run("INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path) VALUES (?, ?)", [
              source,
              "src/dto/tally.ts",
            ]);
          }
          semanticSearch.mockResolvedValue({
            driftWarning: null,
            results: [holder("IndexTally#count", "src/dto/tally.ts")],
          });
        });
        afterEach(() => {
          SHARED.pop();
        });

        /** Shaped like the explore facade: `getIndexMetrics` is a METHOD reading its own instance. */
        class MetricsExplore {
          readonly asked: string[] = [];
          constructor(private readonly popular: number) {}
          semanticSearch = async (request: SemanticSearchRequest) => semanticSearch(request);
          async getIndexMetrics(path: string) {
            this.asked.push(path);
            const labelMap = { typical: 1, popular: this.popular };
            return { signals: { typescript: { "codegraph.file.fanIn": { source: { labelMap } } } } } as never;
          }
        }

        it("its file's fan-in at or above the project's `popular` threshold admits it", async () => {
          const explore = new MetricsExplore(3);
          const result = await buildWithEmbeddings(explore).getNamingLexicon({
            collection: "c",
            path: "/repo",
            names: [{ name: "IndexNumbers", kind: "type", path: "src/api/numbers.ts" }],
          });
          expect(explore.asked).toEqual(["/repo"]);
          expect(result.names[0]).toMatchObject({ alternatives: [{ word: "tally", slot: "head" }] });
          expect(result.notices).toBeUndefined();
        });

        it("below the threshold it stays a one-off", async () => {
          const result = await buildWithEmbeddings(new MetricsExplore(4)).getNamingLexicon({
            collection: "c",
            path: "/repo",
            names: [{ name: "IndexNumbers", kind: "type", path: "src/api/numbers.ts" }],
          });
          expect(result.names[0]).not.toHaveProperty("alternatives");
        });
      });

      it("a head population too small to place a floor on → nothing embedded, no head alternative", async () => {
        // Without the ten null heads only `strategy`, `metrics` and `status` have two carriers.
        await db.run("DELETE FROM cg_type_declarations WHERE short_name LIKE 'Left%' OR short_name LIKE 'Right%'");
        const result = await buildWithEmbeddings().getNamingLexicon({
          collection: "c",
          names: [{ name: "IndexNumbers", kind: "type", path: "src/api/numbers.ts" }],
        });
        expect(embedBatch).not.toHaveBeenCalled();
        expect(result.names[0]).toEqual(expect.objectContaining({ verdict: "NEW_TERM", topTerms: [] }));
        expect(result.names[0]).not.toHaveProperty("alternatives");
        expect(result.notices).toBeUndefined();
      });

      it("a failing embedding is one notice; the drafts are still judged, without head alignment", async () => {
        embedBatch.mockRejectedValue(new Error("embeddings down"));
        const result = await buildWithEmbeddings().getNamingLexicon({
          collection: "c",
          names: [
            { name: "IndexNumbers", kind: "type", path: "src/api/numbers.ts" },
            { name: "IndexFigures", kind: "type", path: "src/api/figures.ts" },
          ],
        });
        expect(embedBatch).toHaveBeenCalledTimes(1);
        expect(result.notices).toEqual(["type-name alignment skipped: embeddings down"]);
        expect(result.names.map((n) => n.verdict)).toEqual(["NEW_TERM", "NEW_TERM"]);
        expect(result.names[0]).not.toHaveProperty("alternatives");
      });
    });

    it("an empty declaration table → a notice naming the codegraph recompute", async () => {
      await db.run("DELETE FROM cg_type_declarations");
      const result = await ops.getNamingLexicon({
        collection: "c",
        names: [{ name: "Commit", kind: "type", path: "src/vcs/commit.ts" }],
      });
      expect(result.notices?.[0]).toMatch(/cg_type_declarations is empty.*--force-enrichments codegraph/);
    });

    it("a type draft without a path is rejected", async () => {
      await expect(
        ops.getNamingLexicon({ collection: "c", names: [{ name: "Commit", kind: "type" }] }),
      ).rejects.toBeInstanceOf(InvalidParameterError);
    });
  });

  // bd tea-rags-mcp-vi0wx (spec §6.4): a changed file never votes for itself.
  // bd tea-rags-mcp-icuxg (vi0wx N2): a Ruby `Result` draft collided with a TSX `Result`, and
  // the answer said `language: "typescript"` for a Ruby-only request.
  describe("type drafts are judged within their own language's type namespace", () => {
    const decl = (language: string, typeId: string) => ({
      language,
      typeId,
      shortName: typeId,
      symbolKind: "class" as const,
      line: 1,
      reopens: false,
      supertypes: [],
    });
    const RUBY_DRAFT = { name: "Result", kind: "type" as const, path: "app/services/getting_paid/payments/result.rb" };

    function buildPolyglot(): NamingLexiconOps {
      const graphDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "close") return async () => undefined;
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      return new NamingLexiconOps({
        pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async (name: string) => name as never,
        explore: { semanticSearch },
        namingConventions: new Map([
          ...NAMING,
          ["javascript", javascriptCapability.naming as IdentifierNamingConvention],
        ]),
        ontologyLanguages: ontologyLanguageProfiles(),
      });
    }

    beforeEach(async () => {
      await db.replaceTypeDeclarationsBulk([
        { relPath: "web/pages/ImportSidebar.tsx", rows: [decl("typescript", "Result")] },
        { relPath: "web/widgets/widget.js", rows: [decl("javascript", "Widget")] },
        { relPath: "app/models/invoice.rb", rows: [decl("ruby", "Invoice")] },
      ]);
      // The project's identifiers are mostly TypeScript: the old fallback answered `typescript`.
      await write([{ relPath: "web/pages/a.ts", rows: [local("a", "row"), local("b", "row")] }], "typescript");
    });

    it("a namesake in another language is no collision, and the answer is in the draft's language", async () => {
      const result = await buildPolyglot().getNamingLexicon({ collection: "c", names: [RUBY_DRAFT] });
      expect(result.language).toBe("ruby");
      expect(result.names[0]).not.toMatchObject({ verdict: "COLLISION" });
      expect(result.names[0].evidence).toMatchObject({ n: 0, collision: false });
      expect(result.names[0]).not.toHaveProperty("language");
    });

    it("a namesake in the same language collides", async () => {
      const result = await buildPolyglot().getNamingLexicon({
        collection: "c",
        names: [{ name: "Invoice", kind: "type", path: "app/billing/invoice.rb" }],
      });
      expect(result.names[0]).toMatchObject({
        verdict: "COLLISION",
        existing: { symbolId: "Invoice", relPath: "app/models/invoice.rb" },
      });
    });

    it("TypeScript and JavaScript share one type namespace", async () => {
      const result = await buildPolyglot().getNamingLexicon({
        collection: "c",
        names: [{ name: "Widget", kind: "type", path: "web/ui/widget.ts" }],
      });
      expect(result.language).toBe("typescript");
      expect(result.names[0]).toMatchObject({
        verdict: "COLLISION",
        existing: { symbolId: "Widget", relPath: "web/widgets/widget.js" },
      });
    });

    it("drafts spanning languages: each judged in its own, a draft off the answer's language names its own", async () => {
      const result = await buildPolyglot().getNamingLexicon({
        collection: "c",
        names: [
          RUBY_DRAFT,
          { name: "Invoice", kind: "type", path: "app/billing/invoice.rb" },
          { name: "Result", kind: "type", path: "web/ui/result.ts" },
        ],
      });
      expect(result.language).toBe("ruby");
      expect(result.names[0]).not.toMatchObject({ verdict: "COLLISION" });
      expect(result.names[1]).toMatchObject({ verdict: "COLLISION" });
      expect(result.names[1]).not.toHaveProperty("language");
      expect(result.names[2]).toMatchObject({
        language: "typescript",
        verdict: "COLLISION",
        existing: { symbolId: "Result", relPath: "web/pages/ImportSidebar.tsx" },
      });
    });

    it("the request's language stays the answer's; a draft in another language names its own", async () => {
      const result = await buildPolyglot().getNamingLexicon({
        collection: "c",
        language: "typescript",
        names: [RUBY_DRAFT],
      });
      expect(result.language).toBe("typescript");
      expect(result.names[0]).toMatchObject({ language: "ruby" });
      expect(result.names[0]).not.toMatchObject({ verdict: "COLLISION" });
    });
  });

  describe("excludePaths reaches every evidence read", () => {
    it("type rows, by-type, by-name, callee, prior sample, homonymy, collisions and generic names", async () => {
      await seedTaxdome();
      const excludePaths = ["app/services/tax/sync_0.rb"];
      const spies = {
        readTypeNameRows: vi.spyOn(db, "readTypeNameRows"),
        aggregateIdentifiersByType: vi.spyOn(db, "aggregateIdentifiersByType"),
        aggregateIdentifiersByName: vi.spyOn(db, "aggregateIdentifiersByName"),
        aggregateIdentifiersByCallee: vi.spyOn(db, "aggregateIdentifiersByCallee"),
        countIdentifiers: vi.spyOn(db, "countIdentifiers"),
        sampleIdentifierShapes: vi.spyOn(db, "sampleIdentifierShapes"),
        readOntologyReportSummary: vi.spyOn(db, "readOntologyReportSummary"),
      };
      const nameTypes = vi.spyOn(db, "identifierNameTypes");
      const shortNames = vi.spyOn(db, "existingSymbolShortNames");
      const graphDb = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === "close") return async () => undefined;
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const excluding = new NamingLexiconOps({
        pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
        collectionRegistry: {} as never,
        resolveActiveCollection: async (name: string) => name as never,
        explore: { semanticSearch },
        namingConventions: NAMING,
        ontologyLanguages: ontologyLanguageProfiles(),
      });

      await excluding.getNamingLexicon(
        {
          collection: "c",
          language: "ruby",
          names: [
            { name: "row", type: DOC },
            { name: "row", callee: { member: "find_tax_automation_document!" } },
            { name: "Commit", kind: "type", path: "app/models/commit.rb" },
          ],
        },
        { excludePaths },
      );

      for (const [read, spy] of Object.entries(spies)) {
        expect(spy, read).toHaveBeenCalled();
        for (const [query] of spy.mock.calls) expect(query, read).toMatchObject({ excludePaths });
      }
      expect(nameTypes).toHaveBeenCalledWith(expect.anything(), excludePaths);
      expect(shortNames).toHaveBeenCalledWith(expect.anything(), excludePaths);
    });
  });
});
