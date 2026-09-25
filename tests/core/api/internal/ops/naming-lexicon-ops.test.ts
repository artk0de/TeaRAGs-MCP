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
import { InputValidationError } from "../../../../../src/core/api/errors.js";
import { NamingLexiconOps } from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import type { ExploreResponse, SemanticSearchRequest } from "../../../../../src/core/api/public/dto/index.js";
import type { IdentifierReplaceEntry, IdentifierRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
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
  });
});
