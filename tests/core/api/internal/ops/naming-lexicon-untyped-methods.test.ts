/**
 * `get_naming_lexicon` judges a method with no known return type by the
 * project's METHOD vocabulary (spec 2026-09-28 naming coverage, §D4): a
 * `return` draft with no type and no callee, in names mode, and every added
 * callable no typed `return` row carries, in diff mode — where the
 * `unknownReturnType` not-judged reason is gone.
 *
 * Runs against an in-process DuckDB holding `cg_symbols` rows; diff mode reads
 * a temp git repo through the real walkers, as `naming-lexicon-diff.test.ts` does.
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
import type { SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import { capability as rubyCapability } from "../../../../../src/core/domains/language/ruby/capability.js";
import { capability as typescriptCapability } from "../../../../../src/core/domains/language/typescript/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["ruby", rubyCapability.naming as IdentifierNamingConvention],
  ["typescript", typescriptCapability.naming as IdentifierNamingConvention],
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

describe("NamingLexiconOps — untyped methods judged by the method vocabulary", { timeout: 60_000 }, () => {
  let dir: string;
  let db: DuckDbGraphClient;
  let semanticSearch: ReturnType<typeof vi.fn<(req: SemanticSearchRequest) => Promise<ExploreResponse>>>;
  let ops: NamingLexiconOps;

  /** One production file per holder, each declaring method `shortName` in `language`. */
  async function methods(language: string, extension: string, count: number, shortName: string): Promise<void> {
    for (let i = 0; i < count; i++) {
      const relPath = `app/${language}/holder_${shortName}_${i}${extension}`;
      const symbolId = `Holder${i}#${shortName}`;
      const definition: SymbolDefinition = {
        symbolId,
        fqName: symbolId,
        shortName,
        relPath,
        scope: [],
        symbolKind: "method",
      };
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?) ON CONFLICT DO NOTHING", [
        relPath,
        language,
      ]);
      await db.upsertSymbols(relPath, [definition]);
    }
  }

  /**
   * The Ruby verb lexicon the fixtures judge by (spec §D4a): `load` and `fetch`
   * each open two noun tails and end no name, so both are verbs.
   */
  async function rubyVerbs(): Promise<void> {
    await methods("ruby", ".rb", 1, "load_order");
    await methods("ruby", ".rb", 1, "fetch_order");
    await methods("ruby", ".rb", 1, "fetch_invoice");
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
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-untyped-methods-"));
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
    it("a verb the project uses conforms, even where the tail's other names use another verb", async () => {
      await rubyVerbs();
      await methods("ruby", ".rb", 3, "load_user");
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [{ name: "fetch_user", kind: "return" }],
      });
      expect(result.names[0]).toMatchObject({ name: "fetch_user", verdict: "CONFORMS" });
    });

    it("another language's methods are no convention for the draft", async () => {
      await rubyVerbs();
      await methods("ruby", ".rb", 3, "load_user");
      const result = await ops.getNamingLexicon({
        collection: "c",
        language: "typescript",
        names: [{ name: "fetchUser", kind: "return" }],
      });
      expect(result.names[0].verdict).not.toBe("MISFIT");
    });

    it("reads the verb vocabulary once and the verbless drafts' last-word slice once per request", async () => {
      await rubyVerbs();
      await methods("ruby", ".rb", 3, "load_user");
      const verbs = vi.spyOn(db, "readMethodHeadWords");
      const matching = vi.spyOn(db, "readMethodNamesMatching");
      await ops.getNamingLexicon({
        collection: "c",
        language: "ruby",
        names: [
          { name: "fetch_user", kind: "return" },
          { name: "fetch_account", kind: "return" },
          { name: "total", kind: "return" },
        ],
      });
      expect(verbs).toHaveBeenCalledTimes(1);
      expect(matching).toHaveBeenCalledTimes(1);
    });
  });

  describe("diff mode", () => {
    let repo: string;

    beforeEach(() => {
      repo = join(dir, "repo");
      mkdirSync(join(repo, "app/users"), { recursive: true });
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "README.md"), "x\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "init");
    });

    it("an added method whose verb the project uses conforms, whatever verb the tail's other names use", async () => {
      await rubyVerbs();
      await methods("ruby", ".rb", 3, "load_user");
      writeFileSync(join(repo, "app/users/finder.rb"), "class Finder\n  def fetch_user\n    1\n  end\nend\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.findings).toEqual([]);
      expect(review?.conforming).toBe(1);
      expect(review?.notJudgedBy).toBeUndefined();
      expect(review?.checked).toBe(review!.conforming + review!.novel + review!.findings.length);
    });

    it("a verb outside NAMING_VERB_PREFIXES is read from the corpus: it conforms beside the tail's other verb", async () => {
      // update opens user and account, sync opens order and invoice; neither is an accessor verb.
      await methods("ruby", ".rb", 3, "update_user");
      await methods("ruby", ".rb", 1, "update_account");
      await methods("ruby", ".rb", 1, "sync_order");
      await methods("ruby", ".rb", 1, "sync_invoice");
      writeFileSync(join(repo, "app/users/syncer.rb"), "class Syncer\n  def sync_user\n    1\n  end\nend\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.findings).toEqual([]);
      expect(review?.conforming).toBe(1);
    });

    it("an added method opening with a verb the project never uses is verbless: novel, never a rename", async () => {
      // update opens user and account; modify opens nothing — outside the lexicon, so no verb to judge.
      await methods("ruby", ".rb", 3, "update_user");
      await methods("ruby", ".rb", 1, "update_account");
      writeFileSync(join(repo, "app/users/editor.rb"), "def modify_user\n  1\nend\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.findings).toEqual([]);
      expect(review?.checked).toBe(1);
      expect(review?.novel).toBe(1);
    });

    it("a macro-composed method is no draft: only the names written on the macro line are judged", async () => {
      // `has_one :account` composes build_account / create_account / account= besides the account reader.
      await rubyVerbs();
      writeFileSync(
        join(repo, "app/users/firm.rb"),
        "class Firm < ApplicationRecord\n  has_one :account\n\n  def refresh_auth_token = 1\nend\n",
      );
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      const judged = [...review!.findings.map((f) => f.name)];
      expect(judged).not.toContain("build_account");
      expect(judged).not.toContain("create_account");
      expect(judged).not.toContain("account=");
      // Firm (the type), its typed `account` reader and refresh_auth_token — not the three composed names.
      expect(review?.checked).toBe(3);
      expect(review?.notJudgedBy).toBeUndefined();
    });

    it("an added method opening with a project noun is no synonym verb, however dominated its tail", async () => {
      // get opens name and title; user ends three names and opens none — a noun.
      await methods("ruby", ".rb", 3, "get_name");
      await methods("ruby", ".rb", 1, "get_title");
      await methods("ruby", ".rb", 3, "load_user");
      writeFileSync(join(repo, "app/users/label.rb"), "class Label\n  def user_name\n    1\n  end\nend\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.findings.filter((f) => f.name === "user_name")).toEqual([]);
    });

    it("an added verbless method with no convention counts as novel, not as a finding", async () => {
      await methods("ruby", ".rb", 3, "load_user");
      writeFileSync(join(repo, "app/users/sums.rb"), "def total\n  1\nend\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.findings).toEqual([]);
      expect(review?.checked).toBe(1);
      expect(review?.novel).toBe(1);
      expect(review?.conforming).toBe(0);
      expect(review?.notJudgedBy).toBeUndefined();
    });
  });
});
