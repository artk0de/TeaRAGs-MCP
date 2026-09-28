/**
 * `get_ontology_report` `verbs` section (spec 2026-09-28 naming coverage, §D5):
 * per language namespace and noun tail, the verbs the project reads the tail
 * with, and the names the untyped-method judgement calls MISFIT against their
 * own group. Opt-in: never computed unless `sections` names it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import {
  OntologyReportOps,
  type OntologyLanguageProfile,
} from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type {
  MethodNamePatternQuery,
  MethodNameRow,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { NAMING_VERB_PREFIXES } from "../../../../../src/core/domains/explore/naming-lexicon/index.js";
import { languageTestFileConventions } from "../../../../../src/core/domains/language/capability/native.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";
import { nonProductionPathPatterns } from "../../../../../src/core/infra/file-classification/index.js";

const casing = (method: "snake" | "camel") => ({
  type: ["pascal" as const],
  module: ["pascal" as const],
  method: [method],
  param: [method],
  local: [method],
  field: [method],
  constant: ["screamingSnake" as const],
});

const RUBY: OntologyLanguageProfile = {
  language: "ruby",
  extensions: [".rb"],
  naming: { casing: casing("snake"), nonConceptTypes: ["String"], implicitSelf: true },
};
const TS: OntologyLanguageProfile = {
  language: "typescript",
  extensions: [".ts"],
  naming: { casing: casing("camel"), nonConceptTypes: ["string"], typeNamespace: "ecmascript" },
};
const JS: OntologyLanguageProfile = {
  language: "javascript",
  extensions: [".js"],
  naming: { casing: casing("camel"), nonConceptTypes: ["string"], typeNamespace: "ecmascript" },
};

const VERB_HEAD_PATTERN = `^(?:${NAMING_VERB_PREFIXES.join("|")})(?:_|[A-Z])`;

function symbol(relPath: string, symbolId: string, symbolKind: SymbolDefinitionKind = "method"): SymbolDefinition {
  const shortName = symbolId.split("#").at(-1) ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], symbolKind };
}

/** A reader serving empty ontology sections and `methodNames` for the verbs read. */
function makeOps(methodNames: MethodNameRow[], languages: OntologyLanguageProfile[] = [RUBY, TS, JS]) {
  const graphDb = {
    readOntologyReportSummary: vi.fn(
      async (): Promise<OntologyReportSummaryRows> => ({
        totals: { identifierRows: 10, symbolRows: 10 },
        genericNameCount: 0,
        genericNames: [],
      }),
    ),
    readOntologyReportSections: vi.fn(async (): Promise<OntologyReportSectionRows> => ({ evidenceRows: 0 })),
    readMethodNamesMatching: vi.fn(async (_q: MethodNamePatternQuery) => methodNames),
    close: vi.fn(async () => undefined),
  };
  const ops = new OntologyReportOps({
    pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
    collectionRegistry: {} as never,
    resolveActiveCollection: async (n: string) => n as never,
    languages,
  });
  return { ops, graphDb };
}

describe("OntologyReportOps#report — verbs over a seeded codegraph", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "ontology-verbs-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    const files: [string, string, SymbolDefinition[]][] = [
      ["app/a.rb", "ruby", [symbol("app/a.rb", "A#load_user"), symbol("app/a.rb", "A#load_account")]],
      ["app/b.rb", "ruby", [symbol("app/b.rb", "B#load_user"), symbol("app/b.rb", "B#load_account")]],
      ["app/c.rb", "ruby", [symbol("app/c.rb", "C#load_user"), symbol("app/c.rb", "C#fetch_user")]],
      ["web/api.ts", "typescript", [symbol("web/api.ts", "Api#loadUser")]],
    ];
    for (const [relPath, language, definitions] of files) {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?)", [relPath, language]);
      await db.upsertSymbols(relPath, definitions);
    }
  });

  afterEach(async () => {
    await db.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  function ops() {
    return new OntologyReportOps({
      pool: { acquireReader: async () => ({ graphDb: db, symbolTable: {} }) } as never,
      collectionRegistry: {} as never,
      resolveActiveCollection: async (n: string) => n as never,
      languages: [RUBY, TS, JS],
    });
  }

  it("groups per language and tail, with verb holders and the MISFIT names suggested by the dominant verb", async () => {
    const res = await ops().report({ collection: "code_x", sections: ["verbs"] });

    const rubyUser = res.verbs?.find((g) => g.tail === "user" && g.language === "ruby");
    expect(rubyUser).toEqual({
      tail: "user",
      language: "ruby",
      holders: 4,
      verbs: [
        { verb: "load", holders: 3 },
        { verb: "fetch", holders: 1 },
      ],
      deviants: [{ name: "fetch_user", holders: 1, suggestion: "load_user" }],
    });
    // The TS `loadUser` is its own group — never merged into the Ruby one.
    expect(res.verbs?.find((g) => g.tail === "user" && g.language === "typescript")).toEqual({
      tail: "user",
      language: "typescript",
      holders: 1,
      verbs: [{ verb: "load", holders: 1 }],
      deviants: [],
    });
    const account = res.verbs?.find((g) => g.tail === "account");
    expect(account?.deviants).toEqual([]);
    expect(res.verbs?.indexOf(account!)).toBeGreaterThan(res.verbs!.indexOf(rubyUser!));
    // Only the requested section.
    expect(res.synonyms).toBeUndefined();
    expect(res.collisions).toBeUndefined();
  });

  it("is opt-in: omitting sections returns no verbs key", async () => {
    const res = await ops().report({ collection: "code_x" });
    expect("verbs" in res).toBe(false);
    expect(res.synonyms).toBeDefined();
  });
});

describe("OntologyReportOps#report — verbs read and shaping", () => {
  it("reads once: the verb-head pattern, grouped by language, scoped like the other ontology reads", async () => {
    const { ops, graphDb } = makeOps([]);
    await ops.report({ collection: "code_x", pathPattern: "app/**", language: "ruby", sections: ["verbs"] });

    expect(graphDb.readMethodNamesMatching).toHaveBeenCalledTimes(1);
    expect(graphDb.readMethodNamesMatching.mock.calls[0][0]).toEqual({
      patterns: [VERB_HEAD_PATTERN],
      groupByLanguage: true,
      pathPrefixes: ["app/"],
      languages: ["ruby"],
      nonProductionPaths: nonProductionPathPatterns(languageTestFileConventions()),
    });
  });

  it("never reads method names when verbs are not requested", async () => {
    const { ops, graphDb } = makeOps([]);
    await ops.report({ collection: "code_x", sections: ["synonyms"] });
    expect(graphDb.readMethodNamesMatching).not.toHaveBeenCalled();
    // The store never sees a `verbs` section.
    expect(graphDb.readOntologyReportSections.mock.calls[0][0].sections).toEqual(["synonyms"]);
  });

  it("languages sharing a type namespace form one group, suggested in the namespace's method casing", async () => {
    const { ops } = makeOps([
      { shortName: "loadUser", holders: 2, language: "typescript" },
      { shortName: "loadUser", holders: 1, language: "javascript" },
      { shortName: "fetchUser", holders: 1, language: "javascript" },
    ]);
    const res = await ops.report({ collection: "code_x", sections: ["verbs"] });
    expect(res.verbs).toEqual([
      {
        tail: "user",
        language: "javascript,typescript",
        holders: 4,
        verbs: [
          { verb: "load", holders: 3 },
          { verb: "fetch", holders: 1 },
        ],
        deviants: [{ name: "fetchUser", holders: 1, suggestion: "loadUser" }],
      },
    ]);
  });

  it("ranks by deviant holders, then holders, and caps groups at limit", async () => {
    const { ops } = makeOps([
      { shortName: "load_account", holders: 9, language: "ruby" },
      { shortName: "load_user", holders: 3, language: "ruby" },
      { shortName: "fetch_user", holders: 1, language: "ruby" },
      { shortName: "build_invoice", holders: 4, language: "ruby" },
      { shortName: "make_invoice", holders: 2, language: "ruby" },
      { shortName: "create_invoice", holders: 1, language: "ruby" },
    ]);
    const res = await ops.report({ collection: "code_x", sections: ["verbs"], limit: 2 });
    expect(res.verbs?.map((g) => [g.tail, g.deviants.reduce((s, d) => s + d.holders, 0)])).toEqual([
      ["invoice", 3],
      ["user", 1],
    ]);
  });

  it("an unreadable graph answers verbs: [] when requested", async () => {
    const ops = new OntologyReportOps({
      pool: {
        acquireReader: async () => {
          throw new Error("locked");
        },
      },
      collectionRegistry: {} as never,
      resolveActiveCollection: async (n: string) => n as never,
      languages: [RUBY],
    });
    const res = await ops.report({ collection: "code_x", sections: ["verbs"] });
    expect(res.verbs).toEqual([]);
    expect(res.notices?.[0]).toMatch(/locked/);
  });
});
