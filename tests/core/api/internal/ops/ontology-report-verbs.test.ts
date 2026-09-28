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
  MethodHeadWordQuery,
  MethodHeadWordRow,
  MethodTailVerbQuery,
  MethodTailVerbRow,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
  SymbolDefinition,
  SymbolDefinitionKind,
} from "../../../../../src/core/contracts/types/codegraph.js";
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

/** A head-word row making `head` a verb of `language`: two tails, never a last word. */
const verb = (head: string, language: string): MethodHeadWordRow => ({
  head,
  headHolders: 2,
  headTails: 2,
  lastHolders: 0,
  valueCompounds: 0,
  language,
});
/** A readMethodTailVerbs row spelled by `name` (`load_user`, `loadUser` → head `load`, tail `user`). */
const pair = (name: string, holders: number, language: string): MethodTailVerbRow => {
  const [, head, tail] = /^([a-z]+)_?(.*)$/.exec(name) ?? [];
  return { tail: tail.replace(/_/g, "").toLowerCase(), head, name, holders, language };
};

function symbol(relPath: string, symbolId: string, symbolKind: SymbolDefinitionKind = "method"): SymbolDefinition {
  const shortName = symbolId.split("#").at(-1) ?? symbolId;
  return { symbolId, fqName: symbolId, shortName, relPath, scope: [], symbolKind };
}

/** A reader serving empty ontology sections, `headWords` and `tailVerbs` for the verbs reads. */
function makeOps(
  headWords: MethodHeadWordRow[],
  tailVerbs: MethodTailVerbRow[],
  languages: OntologyLanguageProfile[] = [RUBY, TS, JS],
) {
  const graphDb = {
    readOntologyReportSummary: vi.fn(
      async (): Promise<OntologyReportSummaryRows> => ({
        totals: { identifierRows: 10, symbolRows: 10 },
        genericNameCount: 0,
        genericNames: [],
      }),
    ),
    readOntologyReportSections: vi.fn(async (): Promise<OntologyReportSectionRows> => ({ evidenceRows: 0 })),
    readMethodHeadWords: vi.fn(async (_q: MethodHeadWordQuery) => headWords),
    readMethodTailVerbs: vi.fn(async (_q: MethodTailVerbQuery) => tailVerbs),
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
      [
        "app/c.rb",
        "ruby",
        [symbol("app/c.rb", "C#load_user"), symbol("app/c.rb", "C#fetch_user"), symbol("app/c.rb", "C#fetch_invoice")],
      ],
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
    // The TS `loadUser` is never merged into the Ruby group (load holds 3 there, not 4); TS has no verb
    // lexicon of its own (load opens one tail), so it forms no group. `account` has one verb: not contested.
    expect(res.verbs?.find((g) => g.language === "typescript")).toBeUndefined();
    expect(res.verbs?.find((g) => g.tail === "account")).toBeUndefined();
    // Only the requested section.
    expect(res.synonyms).toBeUndefined();
    expect(res.collisions).toBeUndefined();
  });

  it("a verb outside NAMING_VERB_PREFIXES is read from the corpus and its deviants named", async () => {
    const files: [string, SymbolDefinition[]][] = [
      ["app/u1.rb", [symbol("app/u1.rb", "U1#update_profile"), symbol("app/u1.rb", "U1#update_account")]],
      ["app/u2.rb", [symbol("app/u2.rb", "U2#update_profile")]],
      ["app/u3.rb", [symbol("app/u3.rb", "U3#sync_profile"), symbol("app/u3.rb", "U3#sync_order")]],
    ];
    for (const [relPath, definitions] of files) {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, 'ruby')", [relPath]);
      await db.upsertSymbols(relPath, definitions);
    }
    const res = await ops().report({ collection: "code_x", sections: ["verbs"] });
    expect(res.verbs?.find((g) => g.tail === "profile")).toEqual({
      tail: "profile",
      language: "ruby",
      holders: 3,
      verbs: [
        { verb: "update", holders: 2 },
        { verb: "sync", holders: 1 },
      ],
      deviants: [{ name: "sync_profile", holders: 1, suggestion: "update_profile" }],
    });
  });

  it("is opt-in: omitting sections returns no verbs key", async () => {
    const res = await ops().report({ collection: "code_x" });
    expect("verbs" in res).toBe(false);
    expect(res.synonyms).toBeDefined();
  });
});

describe("OntologyReportOps#report — verbs read and shaping", () => {
  it("reads the head words, then the lexicon heads' contested tails, both scoped like the other ontology reads", async () => {
    const { ops, graphDb } = makeOps([verb("load", "ruby"), verb("user", "typescript")], []);
    await ops.report({ collection: "code_x", pathPattern: "app/**", language: "ruby", sections: ["verbs"] });

    const scope = {
      groupByLanguage: true,
      pathPrefixes: ["app/"],
      languages: ["ruby"],
      nonProductionPaths: nonProductionPathPatterns(languageTestFileConventions()),
    };
    expect(graphDb.readMethodHeadWords).toHaveBeenCalledTimes(1);
    expect(graphDb.readMethodHeadWords.mock.calls[0][0]).toEqual({ ...scope, minTails: 2 });
    expect(graphDb.readMethodTailVerbs).toHaveBeenCalledTimes(1);
    expect(graphDb.readMethodTailVerbs.mock.calls[0][0]).toEqual({ ...scope, heads: ["load", "user"] });
  });

  it("an empty lexicon reads no tails", async () => {
    const { ops, graphDb } = makeOps([], []);
    const res = await ops.report({ collection: "code_x", sections: ["verbs"] });
    expect(graphDb.readMethodTailVerbs).not.toHaveBeenCalled();
    expect(res.verbs).toEqual([]);
  });

  it("never reads method names when verbs are not requested", async () => {
    const { ops, graphDb } = makeOps([], []);
    await ops.report({ collection: "code_x", sections: ["synonyms"] });
    expect(graphDb.readMethodHeadWords).not.toHaveBeenCalled();
    expect(graphDb.readMethodTailVerbs).not.toHaveBeenCalled();
    // The store never sees a `verbs` section.
    expect(graphDb.readOntologyReportSections.mock.calls[0][0].sections).toEqual(["synonyms"]);
  });

  it("languages sharing a type namespace form one group, suggested in the namespace's method casing", async () => {
    const { ops } = makeOps(
      [
        verb("load", "typescript"),
        { ...verb("fetch", "javascript"), headTails: 1 },
        { ...verb("fetch", "typescript"), headTails: 1 },
      ],
      [pair("loadUser", 2, "typescript"), pair("loadUser", 1, "javascript"), pair("fetchUser", 1, "javascript")],
    );
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
    const { ops } = makeOps(
      ["load", "fetch", "build", "make", "create"].map((head) => verb(head, "ruby")),
      [
        pair("load_account", 9, "ruby"),
        pair("load_user", 3, "ruby"),
        pair("fetch_user", 1, "ruby"),
        pair("build_invoice", 4, "ruby"),
        pair("make_invoice", 2, "ruby"),
        pair("create_invoice", 1, "ruby"),
      ],
    );
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
