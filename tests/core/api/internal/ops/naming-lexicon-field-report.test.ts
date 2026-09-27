/**
 * bd tea-rags-mcp-bjfa0 — the taxdome field report through the query: owners
 * counted by the store, the generic judgement handed to the verdict, and an
 * override found through the owner's in-project ancestry.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import {
  NamingLexiconOps,
  type NamingLexiconExplore,
} from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import { ontologyLanguageProfiles } from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type { ExploreResponse } from "../../../../../src/core/api/public/dto/index.js";
import type {
  IdentifierReplaceEntry,
  IdentifierRow,
  TypeDeclarationRow,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import { capability as rubyCapability } from "../../../../../src/core/domains/language/ruby/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["ruby", rubyCapability.naming as IdentifierNamingConvention],
]);

const TAX_PREPARATION = "TaxPreparation::TaxAutomations::TaxPreparation";
const INQUIRY = "app/policies/bookkeeping/inquiry_policy.rb";

function local(ownerSymbolId: string, name: string, line: number, extra: Partial<IdentifierRow> = {}): IdentifierRow {
  return { ownerSymbolId, kind: "local", name, line, ...extra };
}

function rubyClass(typeId: string, supertypes: string[] = []): TypeDeclarationRow {
  return {
    language: "ruby",
    typeId,
    shortName: typeId.split("::").at(-1) ?? typeId,
    symbolKind: "class",
    line: 1,
    reopens: false,
    supertypes,
  };
}

describe("NamingLexiconOps — the bjfa0 field report", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  async function write(entries: IdentifierReplaceEntry[]): Promise<void> {
    await db.replaceIdentifiersBulk(entries);
    for (const { relPath } of entries) {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?) ON CONFLICT DO NOTHING", [
        relPath,
        "ruby",
      ]);
    }
  }

  async function symbol(relPath: string, symbolId: string): Promise<void> {
    const shortName = symbolId.split(/::|#|\./).at(-1) ?? symbolId;
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, '[]')",
      [relPath, symbolId, symbolId, shortName],
    );
  }

  async function inherits(relPath: string, source: string, ancestor: string): Promise<void> {
    await db.run(
      `INSERT INTO cg_symbols_inheritance
         (source_fq_name, source_rel_path, source_symbol_id, ancestor_fq_name, ancestor_symbol_id, kind, ordinal)
       VALUES (?, ?, ?, ?, ?, 'super', 0)`,
      [source, relPath, source, ancestor, ancestor],
    );
  }

  function build(explore: Partial<NamingLexiconExplore> = {}): NamingLexiconOps {
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
      explore: { semanticSearch: vi.fn(async () => ({ results: [], driftWarning: null })), ...explore },
      namingConventions: NAMING,
      ontologyLanguages: ontologyLanguageProfiles(),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-bjfa0-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("three locals of ONE method are no convention: the type-named draft conforms", async () => {
    const existing = (line: number) =>
      local("FindOrCreate#create_or_merge_on_race!", "existing", line, {
        typeName: TAX_PREPARATION,
        typeSource: "binding",
      });
    await write([{ relPath: "app/services/find_or_create.rb", rows: [existing(3), existing(7), existing(9)] }]);
    const result = await build().getNamingLexicon({
      collection: "c",
      language: "ruby",
      names: [{ name: "tax_preparation", kind: "local", type: TAX_PREPARATION }],
    });
    expect(result.names[0]).toMatchObject({ verdict: "CONFORMS" });
  });

  // Live on taxdome the rows above lent TaxPreparation to every UNTYPED `existing` in the project by name
  // inference, and those, many owners, made the convention. One method's three rows type no name.
  it("one method's typed rows lend their type to no other row of the name", async () => {
    const existing = (line: number) =>
      local("FindOrCreate#create_or_merge_on_race!", "existing", line, {
        typeName: TAX_PREPARATION,
        typeSource: "binding",
      });
    await write([
      { relPath: "app/services/find_or_create.rb", rows: [existing(3), existing(7), existing(9)] },
      {
        relPath: "app/services/others.rb",
        rows: [0, 1, 2, 3, 4].map((i) => local(`Other${i}#call`, "existing", 10 + i)),
      },
    ]);
    const result = await build().getNamingLexicon({
      collection: "c",
      language: "ruby",
      names: [{ name: "tax_preparation", kind: "local", type: TAX_PREPARATION }],
    });
    expect(result.names[0]).toMatchObject({ verdict: "CONFORMS" });
  });

  it("a generic name read off a constant receiver is offered the receiver's concept", async () => {
    // `target` bound to six unrelated types: generic, as get_ontology_report judges it.
    await write([
      {
        relPath: "app/services/runner.rb",
        rows: ["TypeA", "TypeB", "TypeC", "TypeD", "TypeE", "TypeF"].flatMap((typeName, i) =>
          [0, 1].map((j) => local(`Run${i}#call`, "target", 10 * i + j, { typeName, typeSource: "binding" })),
        ),
      },
    ]);
    const result = await build().getNamingLexicon({
      collection: "c",
      language: "ruby",
      names: [
        {
          name: "target",
          kind: "local",
          callee: { member: "read", receiver: "TaxPreparation::TaxAutomations::UploadTargetBuffer" },
        },
      ],
    });
    expect(result.names[0]).toMatchObject({
      verdict: "NEW_TERM",
      topTerms: ["upload_target", "upload_target_buffer"],
      genericName: { typeCount: 6 },
    });
  });

  describe("an override is named by its supertype", () => {
    beforeEach(async () => {
      await db.replaceTypeDeclarationsBulk([
        { relPath: "app/policies/abstract_policy.rb", rows: [rubyClass("AbstractPolicy")] },
        {
          relPath: "app/policies/bookkeeping/abstract_policy.rb",
          rows: [rubyClass("Bookkeeping::AbstractPolicy", ["AbstractPolicy"])],
        },
        { relPath: INQUIRY, rows: [rubyClass("Bookkeeping::InquiryPolicy", ["Bookkeeping::AbstractPolicy"])] },
      ]);
      await inherits("app/policies/bookkeeping/abstract_policy.rb", "Bookkeeping::AbstractPolicy", "AbstractPolicy");
      await inherits(INQUIRY, "Bookkeeping::InquiryPolicy", "Bookkeeping::AbstractPolicy");
      await symbol("app/policies/abstract_policy.rb", "AbstractPolicy#same_firm?");
      await symbol("app/policies/bookkeeping/abstract_policy.rb", "Bookkeeping::AbstractPolicy#same_firm?");
      await symbol(INQUIRY, "Bookkeeping::InquiryPolicy#same_firm?");
      for (const other of ["TagPolicy", "Crm::ContactPolicy", "Crm::ClientNotePolicy"]) {
        await symbol(`app/policies/${other.toLowerCase()}.rb`, `${other}#same_firm?`);
      }
    });

    it("names mode with `path`: CONFORMS, declared by the nearest ancestor; its collisions rank ancestors first", async () => {
      // The symbol lookup ranks the namesakes arbitrarily and returns no ancestor at all.
      const payload = (symbolId: string) => ({
        id: symbolId,
        score: 1,
        payload: { symbolId, relativePath: `app/policies/${symbolId}.rb` },
      });
      const findSymbol = vi.fn(
        async (): Promise<ExploreResponse> => ({
          driftWarning: null,
          results: [
            payload("TagPolicy#same_firm?"),
            payload("Crm::ContactPolicy#same_firm?"),
            payload("Crm::ClientNotePolicy#same_firm?"),
          ],
        }),
      );
      const result = await build({ findSymbol }).getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "same_firm?", kind: "return", path: INQUIRY }],
      });
      expect(result.names[0]).toMatchObject({
        verdict: "CONFORMS",
        override: { declaredBy: "Bookkeeping::AbstractPolicy#same_firm?" },
        evidence: {
          collision: true,
          collisions: ["Bookkeeping::AbstractPolicy#same_firm?", "AbstractPolicy#same_firm?", "TagPolicy#same_firm?"],
        },
      });
    });

    it("a method no ancestor declares is judged as before", async () => {
      const result = await build().getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "can_resolve?", kind: "return", path: INQUIRY }],
      });
      expect(result.names[0]).toMatchObject({ verdict: "NEW_TERM", topTerms: [] });
      expect(result.names[0]).not.toHaveProperty("override");
    });

    it("without `path` the owner is unknown: names mode is left as it was", async () => {
      const result = await build().getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "same_firm?", kind: "return" }],
      });
      expect(result.names[0]).not.toHaveProperty("override");
    });
  });
});
