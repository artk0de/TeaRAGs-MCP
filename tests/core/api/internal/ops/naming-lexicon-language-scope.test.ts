/**
 * `get_naming_lexicon` reads a draft's evidence within its language namespace
 * (bd tea-rags-mcp-0qaht): the draft's language and every language sharing its
 * naming convention's `typeNamespace` — TypeScript and JavaScript share one,
 * Ruby stands alone. In a polyglot repo Ruby locals never vote on a TypeScript
 * value, and a Ruby symbol is no collision for a TypeScript name.
 *
 * Runs against an in-process DuckDB holding `cg_identifiers`, `cg_symbols` and
 * `cg_symbols_files` rows; diff mode reads a temp git repo through the real
 * walkers, as `naming-lexicon-diff.test.ts` does.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { NamingLexiconOps } from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import { createNamingReviewExtractor } from "../../../../../src/core/api/internal/ops/naming-review-extraction.js";
import { ontologyLanguageProfiles } from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type { ExploreResponse, SemanticSearchRequest } from "../../../../../src/core/api/public/dto/index.js";
import type { IdentifierRow } from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import { capability as javascriptCapability } from "../../../../../src/core/domains/language/javascript/capability.js";
import { capability as rubyCapability } from "../../../../../src/core/domains/language/ruby/capability.js";
import { capability as typescriptCapability } from "../../../../../src/core/domains/language/typescript/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["ruby", rubyCapability.naming as IdentifierNamingConvention],
  ["typescript", typescriptCapability.naming as IdentifierNamingConvention],
  ["javascript", javascriptCapability.naming as IdentifierNamingConvention],
]);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    },
  });
}

function typed(
  ownerSymbolId: string,
  name: string,
  typeName: string,
  kind: IdentifierRow["kind"] = "local",
): IdentifierRow {
  return { ownerSymbolId, kind, name, line: 3, typeName, typeSource: "annotation" };
}

describe("NamingLexiconOps — evidence stays within the draft's language namespace", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;
  let db: DuckDbGraphClient;
  let semanticSearch: ReturnType<typeof vi.fn<(req: SemanticSearchRequest) => Promise<ExploreResponse>>>;
  let ops: NamingLexiconOps;

  /** One file per holder, each naming a `typeName` value `name`, in `language`. */
  async function holders(
    language: string,
    extension: string,
    count: number,
    name: string,
    typeName: string,
    kind: IdentifierRow["kind"] = "local",
  ) {
    for (let i = 0; i < count; i++) {
      const relPath = `lib/${language}/holder_${name}_${i}${extension}`;
      await db.replaceIdentifiersBulk([{ relPath, rows: [typed(`${language}${name}${i}#run`, name, typeName, kind)] }]);
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?) ON CONFLICT DO NOTHING", [
        relPath,
        language,
      ]);
    }
  }

  async function symbol(relPath: string, language: string, symbolId: string, shortName: string): Promise<void> {
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, '[]')",
      [relPath, symbolId, symbolId, shortName],
    );
    await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?) ON CONFLICT DO NOTHING", [
      relPath,
      language,
    ]);
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
      ontologyLanguages: ontologyLanguageProfiles(),
      extractDeclarations: createNamingReviewExtractor(new LanguageFactory({})),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-language-scope-"));
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

  describe("names mode", () => {
    const DRAFT = { name: "account", type: "User" };

    it("Ruby evidence decides nothing for a TypeScript draft: with no TS/JS rows it has no convention", async () => {
      await holders("ruby", ".rb", 3, "user", "User");
      const result = await ops.getNamingLexicon({ collection: "c", language: "typescript", names: [DRAFT] });
      expect(result.names[0]).toMatchObject({ name: "account", verdict: "NO_CONVENTION" });
      expect(result.byType).toEqual([]);
    });

    it("JavaScript evidence counts for a TypeScript draft: one type namespace", async () => {
      await holders("javascript", ".js", 3, "user", "User");
      const result = await ops.getNamingLexicon({ collection: "c", language: "typescript", names: [DRAFT] });
      expect(result.names[0]).toMatchObject({ name: "account", verdict: "MISFIT", suggestion: "user" });
    });

    it("a Ruby symbol of the draft's short name is no collision for a TypeScript draft", async () => {
      await symbol("app/models/account.rb", "ruby", "Billing#account", "account");
      const result = await ops.getNamingLexicon({ collection: "c", language: "typescript", names: [DRAFT] });
      expect(result.names[0].evidence).toMatchObject({ collision: false });
      const ruby = await ops.getNamingLexicon({ collection: "c", language: "ruby", names: [DRAFT] });
      expect(ruby.names[0].evidence).toMatchObject({ collision: true });
    });
  });

  describe("diff mode", () => {
    beforeEach(() => {
      repo = join(dir, "repo");
      mkdirSync(join(repo, "app/sync"), { recursive: true });
      mkdirSync(join(repo, "src/sync"), { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "README.md"), "x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
    });

    it("a diff touching a Ruby and a TypeScript file judges each language's drafts against its own rows", async () => {
      // Ruby names Document params `document` (4 holders), TypeScript names them `doc` (3).
      await holders("ruby", ".rb", 4, "document", "Document", "param");
      await holders("typescript", ".ts", 3, "doc", "Document", "param");
      writeFileSync(
        join(repo, "app/sync/store.rb"),
        "class Store\n  # @param record [Document]\n  def run(record)\n    record\n  end\nend\n",
      );
      writeFileSync(
        join(repo, "src/sync/store.ts"),
        "export function run(record: Document): void {\n  use(record);\n}\n",
      );
      const { review } = await ops.getNamingLexicon({
        collection: "c",
        path: repo,
        files: ["app/sync/store.rb", "src/sync/store.ts"],
      });
      const finding = (relPath: string) => review?.findings.find((f) => f.relPath === relPath && f.name === "record");
      // Merged across languages, both drafts were offered both words (topTerms ["document", "doc"]).
      expect(finding("app/sync/store.rb")).toMatchObject({
        type: "Document",
        verdict: "MISFIT",
        suggestion: "document",
      });
      expect(finding("src/sync/store.ts")).toMatchObject({ type: "Document", topTerms: ["doc"] });
    });
  });
});
