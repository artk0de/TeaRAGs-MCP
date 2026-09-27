/**
 * Diff mode of `get_naming_lexicon` (bd tea-rags-mcp-fdef2, spec §6): the
 * declarations a working-tree change ADDS are judged against the project's
 * vocabulary, with every changed file excluded from the evidence.
 *
 * A temp git repo holds the change; an in-process DuckDB holds the index —
 * including the OLD version of the changed file, as an incremental reindex or
 * the auto-update watcher would leave it. The drafts come from the real
 * TypeScript walker, through the same in-memory extraction the tool uses.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
import { InvalidParameterError } from "../../../../../src/core/api/errors.js";
import {
  NamingLexiconOps,
  type NamingLexiconEmbeddings,
} from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
import { createNamingReviewExtractor } from "../../../../../src/core/api/internal/ops/naming-review-extraction.js";
import { ontologyLanguageProfiles } from "../../../../../src/core/api/internal/ops/ontology-report-ops.js";
import type { ExploreResponse, SemanticSearchRequest } from "../../../../../src/core/api/public/dto/index.js";
import type {
  IdentifierReplaceEntry,
  IdentifierRow,
  TypeDeclarationRow,
} from "../../../../../src/core/contracts/types/codegraph.js";
import type { IdentifierNamingConvention } from "../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import { capability as typescriptCapability } from "../../../../../src/core/domains/language/typescript/capability.js";
import { DATABASE_MIGRATIONS } from "../../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../../src/core/domains/maintenance/migration/database/runner.js";

const NAMING = new Map<string, IdentifierNamingConvention>([
  ["typescript", typescriptCapability.naming as IdentifierNamingConvention],
]);

const CHANGED = "src/git/file-reader.ts";

const ORIGINAL = `export function load(): void {
  const other: GitFileSignals = read();
  use(other);
}
`;

const CHANGED_TEXT = `export function load(): void {
  const other: GitFileSignals = read();
  use(other);
}

export function scan(): void {
  const meta: GitFileSignals = read();
  const fileSignals: GitFileSignals = read();
  const result: RunReport = run();
  use(meta, fileSignals, result);
}

export class Commit {}
`;

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

function local(ownerSymbolId: string, name: string, extra: Partial<IdentifierRow> = {}): IdentifierRow {
  return { ownerSymbolId, kind: "local", name, line: 3, ...extra };
}

function decl(typeId: string, symbolKind: TypeDeclarationRow["symbolKind"]): TypeDeclarationRow {
  return { language: "typescript", typeId, shortName: typeId, symbolKind, line: 1, reopens: false, supertypes: [] };
}

describe("NamingLexiconOps — diff mode", { timeout: 60_000 }, () => {
  let dir: string;
  let repo: string;
  let db: DuckDbGraphClient;
  let semanticSearch: ReturnType<typeof vi.fn<(req: SemanticSearchRequest) => Promise<ExploreResponse>>>;
  let ops: NamingLexiconOps;

  async function write(entries: IdentifierReplaceEntry[]): Promise<void> {
    await db.replaceIdentifiersBulk(entries);
    for (const { relPath } of entries) {
      await db.run("INSERT INTO cg_symbols_files (rel_path, language) VALUES (?, ?) ON CONFLICT DO NOTHING", [
        relPath,
        "typescript",
      ]);
    }
  }

  async function seedIndex(): Promise<void> {
    await write([
      // The project names GitFileSignals values `fileSignals`.
      ...[0, 1, 2, 3, 4, 5].map((i) => ({
        relPath: `src/git/reader-${i}.ts`,
        rows: [local(`read${i}`, "fileSignals", { typeName: "GitFileSignals", typeSource: "annotation" })],
      })),
      // The changed file as already indexed: `meta` ten times would outvote the project.
      {
        relPath: CHANGED,
        rows: Array.from({ length: 10 }, (_, i) =>
          local(`scan${i}`, "meta", { typeName: "GitFileSignals", typeSource: "annotation", line: 10 + i }),
        ),
      },
      // `result` bound to five unrelated types — generic — and six times to RunReport.
      {
        relPath: "src/run/runner.ts",
        rows: [
          ...["TypeA", "TypeB", "TypeC", "TypeD", "TypeE"].flatMap((typeName, i) =>
            [0, 1].map((j) => local(`run${i}`, "result", { typeName, typeSource: "annotation", line: 10 * i + j })),
          ),
          ...[0, 1, 2, 3, 4, 5].map((i) =>
            local(`report${i}`, "result", { typeName: "RunReport", typeSource: "annotation", line: 100 + i }),
          ),
        ],
      },
    ]);
    await db.replaceTypeDeclarationsBulk([
      ...Array.from({ length: 20 }, (_, i) => ({
        relPath: `src/f${i}/x.ts`,
        rows: [decl(`Filler${String.fromCharCode(97 + i)}`, "class")],
      })),
      { relPath: "src/vcs/commit.ts", rows: [decl("Commit", "class")] },
    ]);
  }

  function build(embeddings?: NamingLexiconEmbeddings): NamingLexiconOps {
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
      ...(embeddings !== undefined ? { embeddings } : {}),
    });
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "naming-lexicon-diff-"));
    repo = join(dir, "repo");
    mkdirSync(join(repo, "src/git"), { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, CHANGED), ORIGINAL);
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, CHANGED), CHANGED_TEXT);

    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await seedIndex();
    semanticSearch = vi.fn(async () => ({ results: [], driftWarning: null }));
    ops = build();
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports the added declarations that do not conform, each with file:line; the rest only count", async () => {
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
    const { review } = result;
    expect(review).toBeDefined();
    expect(review?.base).toBe("HEAD");

    // `meta` would conform on the changed file's own indexed rows — excluded, it is a MISFIT.
    expect(review?.findings).toContainEqual(
      expect.objectContaining({
        relPath: CHANGED,
        line: 7,
        name: "meta",
        kind: "local",
        type: "GitFileSignals",
        verdict: "MISFIT",
        suggestion: "fileSignals",
      }),
    );
    // bd tea-rags-mcp-bjfa0: a generic name that conforms is a note, not a finding — it counts as conforming.
    expect(review?.notes).toEqual([
      {
        relPath: CHANGED,
        line: 9,
        name: "result",
        kind: "local",
        type: "RunReport",
        genericName: { typeCount: 6, n: 16 },
      },
    ]);
    // A new class whose short name another module declares.
    expect(review?.findings).toContainEqual(
      expect.objectContaining({
        name: "Commit",
        line: 13,
        kind: "class",
        verdict: "COLLISION",
        existing: { symbolId: "Commit", relPath: "src/vcs/commit.ts" },
      }),
    );
    const names = review?.findings.map((f) => f.name) ?? [];
    // The unchanged declaration in the same file is not reviewed.
    expect(names).not.toContain("other");
    // A conforming declaration only raises `conforming`.
    expect(names).not.toContain("fileSignals");
    expect(review?.conforming).toBeGreaterThanOrEqual(1);
    expect(review?.checked).toBe(review!.conforming + review!.novel + review!.findings.length);
    expect(review?.truncated).toBeUndefined();
  });

  it("`files` reviews the named files' added lines against the base", async () => {
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: [CHANGED] });
    // bd tea-rags-mcp-bjfa0: the conforming generic `result` moved from findings to notes.
    expect(result.review?.findings.map((f) => f.name).sort()).toEqual(["Commit", "meta"]);
    expect(result.review?.notes?.map((n) => n.name)).toEqual(["result"]);
  });

  it("an untracked file is reviewed whole", async () => {
    writeFileSync(join(repo, "src/git/fresh.ts"), "// one\n// two\nexport class Commit {}\n");
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/fresh.ts"] });
    expect(result.review?.findings).toEqual([
      expect.objectContaining({ relPath: "src/git/fresh.ts", line: 3, name: "Commit", verdict: "COLLISION" }),
    ]);
  });

  // bd tea-rags-mcp-icuxg: a diff spanning languages judges each name within its own language.
  it("a type declared in another language is no collision; one in the same language is", async () => {
    await db.replaceTypeDeclarationsBulk([
      { relPath: "app/models/invoice.rb", rows: [{ ...decl("Invoice", "class"), language: "ruby" }] },
    ]);
    mkdirSync(join(repo, "app/billing"), { recursive: true });
    writeFileSync(join(repo, "app/billing/documents.rb"), "class Commit\nend\n\nclass Invoice\nend\n");
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["app/billing/documents.rb"] });
    const collisions = result.review?.findings.filter((f) => f.verdict === "COLLISION") ?? [];
    expect(collisions).toEqual([
      expect.objectContaining({
        relPath: "app/billing/documents.rb",
        name: "Invoice",
        existing: { symbolId: "Invoice", relPath: "app/models/invoice.rb" },
      }),
    ]);
  });

  it("a NEW_TERM with nothing to compare with is counted as novel, not listed", async () => {
    writeFileSync(
      join(repo, "src/git/novel.ts"),
      "export function g(): void {\n  const thing = mysteryCall();\n  use(thing);\n}\n",
    );
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/novel.ts"] });
    expect(result.review?.findings).toEqual([]);
    expect(result.review?.novel).toBe(1);
    expect(result.review?.checked).toBe(1);
  });

  // bd tea-rags-mcp-hn2vt: `thing` / `tmp` for a call the project names `entry` were silently conforming.
  it("a local named off the project's names for its call is a finding carrying those names", async () => {
    await write(
      [0, 1, 2].map((i) => ({
        relPath: `src/reg/lookup-${i}.ts`,
        rows: [local(`lookup${i}`, "entry", { boundMember: "findByName", boundReceiver: "registry" })],
      })),
    );
    writeFileSync(
      join(repo, "src/git/scratch.ts"),
      "export function g(): void {\n  const thing = registry.findByName(n);\n  const entry = registry.findByName(m);\n  use(thing, entry);\n}\n",
    );
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/scratch.ts"] });
    expect(result.review?.findings).toEqual([
      expect.objectContaining({ name: "thing", line: 2, kind: "local", verdict: "NEW_TERM", topTerms: ["entry"] }),
    ]);
    expect(result.review?.conforming).toBe(1);
  });

  it("a non-production changed file is not judged, and counts as not judged", async () => {
    writeFileSync(
      join(repo, "src/git/reader.test.ts"),
      "export function t(): void {\n  const meta: GitFileSignals = read();\n  use(meta);\n}\n",
    );
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/reader.test.ts"] });
    expect(result.review?.findings).toEqual([]);
    expect(result.review?.checked).toBe(0);
    expect(result.review?.notJudged).toBe(1);
  });

  it("a type draft's concept query carries its words and the code of its enclosing chunk", async () => {
    writeFileSync(
      join(repo, "src/git/calculated.ts"),
      "export class CalculatedDoc {\n  total(): number {\n    return reconcileLedgerTotals(this);\n  }\n}\n",
    );
    await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/calculated.ts"] });
    expect(semanticSearch).toHaveBeenCalledTimes(1);
    const { query } = semanticSearch.mock.calls[0][0];
    expect(query.startsWith("calculated doc")).toBe(true);
    expect(query).toContain("reconcileLedgerTotals(this)");
  });

  it("a file no codegraph language walks is counted as not judged", async () => {
    writeFileSync(join(repo, "notes.md"), "# notes\n");
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
    expect(result.review?.notJudged).toBe(1);
  });

  it("identical drafts in one directory are judged once and reported per declaration", async () => {
    const commit = "export class Commit {}\n";
    writeFileSync(join(repo, "src/git/a.ts"), commit);
    writeFileSync(join(repo, "src/git/b.ts"), commit);
    const result = await ops.getNamingLexicon({
      collection: "c",
      path: repo,
      files: ["src/git/a.ts", "src/git/b.ts"],
    });
    expect(result.review?.findings.map((f) => `${f.relPath}:${f.line}:${f.verdict}`)).toEqual([
      "src/git/a.ts:1:COLLISION",
      "src/git/b.ts:1:COLLISION",
    ]);
    // One alignment search for the one distinct type draft.
    expect(semanticSearch).toHaveBeenCalledTimes(1);
  });

  it("a failing alignment search is one notice for the whole review, and the drafts are still judged", async () => {
    semanticSearch.mockRejectedValue(new Error("ollama unreachable"));
    writeFileSync(join(repo, "src/git/a.ts"), "export class Commit {}\n");
    writeFileSync(join(repo, "src/git/b.js"), "export class Commit {}\n");
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/a.ts", "src/git/b.js"] });
    expect(result.review?.findings.map((f) => f.verdict)).toEqual(["COLLISION", "COLLISION"]);
    expect(result.notices).toEqual(["type-name alignment skipped: ollama unreachable"]);
    expect(semanticSearch).toHaveBeenCalledTimes(1);
  });

  it("caps the changed files at 200 per call", async () => {
    mkdirSync(join(repo, "notes"));
    for (let i = 0; i < 201; i++) writeFileSync(join(repo, `notes/n${String(i).padStart(3, "0")}.md`), "x\n");
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
    expect(result.review?.truncated).toEqual({ cap: 200, skipped: 2 });
  });

  // bd tea-rags-mcp-433d2: a synonym head passes the project-suffix rule; its alternative makes it a finding.
  it("a CONFORMS carrying head alternatives is a finding, not a conforming count", async () => {
    await db.replaceTypeDeclarationsBulk([
      { relPath: "src/a/foo.ts", rows: [decl("FooBackend", "class")] },
      { relPath: "src/b/bar.ts", rows: [decl("BarBackend", "class")] },
      { relPath: "src/c/baz.ts", rows: [decl("BazBackend", "class")] },
      { relPath: "src/emb/provider.ts", rows: [decl("EmbeddingProvider", "class")] },
      { relPath: "src/code/provider.ts", rows: [decl("CodeProvider", "class")] },
      // Ten more heads, two carriers each: a null population large enough to measure a floor.
      ...["Anchor", "Beacon", "Cable", "Dagger", "Ember", "Falcon", "Glacier", "Harbor", "Island", "Jetty"].flatMap(
        (head) =>
          ["Left", "Right"].map((side) => ({
            relPath: `src/${head.toLowerCase()}/${side.toLowerCase()}.ts`,
            rows: [decl(`${side}${head}`, "class")],
          })),
      ),
    ]);
    semanticSearch.mockResolvedValue({
      driftWarning: null,
      results: [{ id: "p", score: 1, payload: { symbolId: "EmbeddingProvider", relativePath: "src/emb/provider.ts" } }],
    });
    // `backend` and `provider` share a direction; every other head is its own axis (null pairs score 0).
    const axes = new Map<string, number>();
    const embedBatch = vi.fn(async (texts: string[]) =>
      texts.map((text) => {
        const word = text.replace(/^class /, "");
        const embedding = new Array<number>(32).fill(0);
        if (word === "backend" || word === "provider") embedding[0] = 1;
        else embedding[axes.get(word) ?? axes.set(word, axes.size + 1).get(word) ?? 0] = 1;
        return { embedding };
      }),
    );
    mkdirSync(join(repo, "src/emb"), { recursive: true });
    writeFileSync(join(repo, "src/emb/backend.ts"), "export class EmbeddingBackend {}\n");
    const result = await build({ embedBatch }).getNamingLexicon({
      collection: "c",
      path: repo,
      files: ["src/emb/backend.ts"],
    });
    expect(result.review?.findings).toEqual([
      expect.objectContaining({
        name: "EmbeddingBackend",
        verdict: "CONFORMS",
        alternatives: [expect.objectContaining({ word: "provider", slot: "head" })],
      }),
    ]);
    expect(result.review?.conforming).toBe(0);
  });

  // bd tea-rags-mcp-59q9c: live on taxdome the namespace modules were MISFIT → `GettingPaidWorker` / `QuickbooksWorker`.
  it("the namespace modules around a worker get no directory-role MISFIT; the worker is judged by it", async () => {
    const dirPath = "app/workers/getting_paid/quickbooks";
    const ruby = (typeId: string, symbolKind: TypeDeclarationRow["symbolKind"]): TypeDeclarationRow => ({
      ...decl(typeId, symbolKind),
      language: "ruby",
    });
    await db.replaceTypeDeclarationsBulk(
      [
        ["import_invoices_worker", "ImportInvoicesWorker"],
        ["sync_payments_worker", "SyncPaymentsWorker"],
        ["push_customers_worker", "PushCustomersWorker"],
      ].map(([stem, worker]) => ({
        relPath: `${dirPath}/${stem}.rb`,
        rows: [ruby("GettingPaid", "module"), ruby("Quickbooks", "module"), ruby(worker, "class")],
      })),
    );
    mkdirSync(join(repo, dirPath), { recursive: true });
    const scratch = `${dirPath}/sync_ledger.rb`;
    writeFileSync(
      join(repo, scratch),
      "module GettingPaid\n  module Quickbooks\n    class SyncLedger\n      def perform; end\n    end\n  end\nend\n",
    );
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: [scratch] });
    const misfits = result.review?.findings.filter((f) => f.verdict === "MISFIT") ?? [];
    expect(misfits).toEqual([
      expect.objectContaining({ name: "SyncLedger", line: 3, suggestion: "SyncLedgerWorker", kind: "class" }),
    ]);
  });

  // bd tea-rags-mcp-y33ee: a base branch that moved on flooded the review with files only the base changed.
  describe("a base branch that moved on since the branch left it", () => {
    const SHARED = "src/git/shared.ts";
    let forkPoint: string;

    beforeEach(() => {
      // The fork point carries `shared.ts`; the branch commits its change; main then rewrites `shared.ts`.
      writeFileSync(join(repo, CHANGED), ORIGINAL);
      writeFileSync(join(repo, SHARED), "export class Commit {}\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "shared");
      forkPoint = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "-b", "feat");
      writeFileSync(join(repo, CHANGED), CHANGED_TEXT);
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "feat");
      git(repo, "checkout", "-q", "main");
      writeFileSync(join(repo, SHARED), "export class Kommit {}\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "main moves on");
      git(repo, "checkout", "-q", "feat");
    });

    it("reviews what the branch changed since its merge-base with the base, and reports that commit", async () => {
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: { base: "main" } });
      expect(review?.base).toBe("main");
      expect(review?.mergeBase).toBe(forkPoint);
      expect(review?.changedFiles).toBe(1);
      expect(new Set(review?.findings.map((f) => f.relPath))).toEqual(new Set([CHANGED]));
      // bd tea-rags-mcp-bjfa0: the conforming generic `result` is a note, not a finding.
      expect(review?.findings.map((f) => f.name).sort()).toEqual(["Commit", "meta"]);
      expect(review?.notes?.map((n) => n.name)).toEqual(["result"]);
    });

    it("a base HEAD descends from is compared as given", async () => {
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: { base: forkPoint } });
      expect(review?.mergeBase).toBe(forkPoint);
      expect(review?.changedFiles).toBe(1);
    });

    it("a base HEAD shares no history with is a parameter error saying there is no merge-base", async () => {
      const emptyTree = git(repo, "hash-object", "-t", "tree", "/dev/null").trim();
      const orphan = git(repo, "commit-tree", emptyTree, "-m", "orphan").trim();
      const call = ops.getNamingLexicon({ collection: "c", path: repo, changes: { base: orphan } });
      await expect(call).rejects.toBeInstanceOf(InvalidParameterError);
      await expect(call).rejects.toThrow(/no merge-base/);
    });

    it("an unknown base is a parameter error", async () => {
      await expect(
        ops.getNamingLexicon({ collection: "c", path: repo, changes: { base: "no-such-branch" } }),
      ).rejects.toBeInstanceOf(InvalidParameterError);
    });
  });

  it("the default base is HEAD itself: its merge-base is HEAD's commit", async () => {
    const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
    expect(review?.mergeBase).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(review?.changedFiles).toBe(1);
    expect(review?.wholeFiles).toBeUndefined();
  });

  // bd tea-rags-mcp-y33ee: `files` on a clean tree checked 0 — the files were committed, so nothing was "added".
  it("`files` with no diff against the base reviews every declaration they hold, and says so", async () => {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "committed");
    const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, files: [CHANGED] });
    expect(review?.wholeFiles).toBe(1);
    expect(review?.changedFiles).toBe(0);
    const names = review?.findings.map((f) => f.name) ?? [];
    // `other` sits on a line the working tree did not add: only a whole-file review judges it.
    expect(names).toEqual(expect.arrayContaining(["meta", "Commit", "other"]));
    // bd tea-rags-mcp-bjfa0: the conforming generic `result` is judged too, and listed as a note.
    expect(review?.notes?.map((n) => n.name)).toEqual(["result"]);
    expect(review?.checked).toBe(review!.conforming + review!.novel + review!.findings.length);
  });

  it("`files` keeps the added-lines review for a listed file that has a diff", async () => {
    const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, files: [CHANGED] });
    expect(review?.wholeFiles).toBeUndefined();
    expect(review?.changedFiles).toBe(1);
    expect(review?.findings.map((f) => f.name)).not.toContain("other");
  });

  it("a listed file that does not exist is counted as not judged", async () => {
    const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/missing.ts"] });
    expect(review?.checked).toBe(0);
    expect(review?.notJudged).toBe(1);
  });

  // bd tea-rags-mcp-y33ee: new methods with no known return type vanished from the counts, so
  // `conforming` read as if they had been reviewed.
  describe("what the review did not judge", () => {
    it("a method with no known return type is listed by kind and reason; a constructor is not", async () => {
      mkdirSync(join(repo, "app/billing"), { recursive: true });
      writeFileSync(
        join(repo, "app/billing/ledger_sync.rb"),
        "class LedgerSync\n  def initialize(ledger)\n    @ledger = ledger\n  end\n\n  def perform\n    1\n  end\nend\n",
      );
      const { review } = await ops.getNamingLexicon({
        collection: "c",
        path: repo,
        files: ["app/billing/ledger_sync.rb"],
      });
      expect(review?.notJudgedBy).toEqual({ method: { unknownReturnType: 1 } });
      expect(review?.notJudgedNames).toEqual([
        {
          relPath: "app/billing/ledger_sync.rb",
          line: 6,
          name: "perform",
          kind: "method",
          reason: "unknownReturnType",
        },
      ]);
      // Declarations stay the only thing `notJudged` does not count: it counts files.
      expect(review?.notJudged).toBe(0);
    });

    // Live on taxdome: a `module_function` method is one declaration under two symbols (`M#x`, `M.x`).
    it("a method declared once under two symbols is listed once", async () => {
      mkdirSync(join(repo, "app/billing"), { recursive: true });
      writeFileSync(
        join(repo, "app/billing/refusals.rb"),
        "module Refusals\n  module_function\n\n  def refuse!(error)\n    error\n  end\nend\n",
      );
      const { review } = await ops.getNamingLexicon({
        collection: "c",
        path: repo,
        files: ["app/billing/refusals.rb"],
      });
      expect(review?.notJudgedBy).toEqual({ method: { unknownReturnType: 1 } });
      expect(review?.notJudgedNames).toEqual([
        { relPath: "app/billing/refusals.rb", line: 4, name: "refuse!", kind: "method", reason: "unknownReturnType" },
      ]);
    });

    it("a file that was not judged is listed with why", async () => {
      writeFileSync(join(repo, "src/git/reader.test.ts"), "export const x = 1;\n");
      writeFileSync(join(repo, "notes.md"), "# notes\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.notJudged).toBe(2);
      expect(review?.notJudgedBy?.file).toEqual({ nonProduction: 1, noCodegraphLanguage: 1 });
      expect(review?.notJudgedNames).toEqual(
        expect.arrayContaining([
          { relPath: "notes.md", kind: "file", reason: "noCodegraphLanguage" },
          { relPath: "src/git/reader.test.ts", kind: "file", reason: "nonProduction" },
        ]),
      );
    });

    it("everything judged: no breakdown", async () => {
      writeFileSync(join(repo, "src/git/typed.ts"), "export function total(): number {\n  return 1;\n}\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/typed.ts"] });
      expect(review?.checked).toBe(1);
      expect(review?.notJudgedBy).toBeUndefined();
      expect(review?.notJudgedNames).toBeUndefined();
    });

    it("caps the listed names and keeps the counts whole", async () => {
      mkdirSync(join(repo, "app/many"), { recursive: true });
      const methods = Array.from({ length: 60 }, (_, i) => `  def step_${i}\n    1\n  end\n`).join("");
      writeFileSync(join(repo, "app/many/runner.rb"), `class Runner\n${methods}end\n`);
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["app/many/runner.rb"] });
      expect(review?.notJudgedBy).toEqual({ method: { unknownReturnType: 60 } });
      expect(review?.notJudgedNames).toHaveLength(50);
    });
  });

  // bd tea-rags-mcp-bjfa0: taxdome's `same_firm?` in Bookkeeping::InquiryPolicy, overriding AbstractPolicy#same_firm?.
  it("a method its enclosing class's ancestor declares is an override: it conforms, never novel", async () => {
    mkdirSync(join(repo, "src/policy"), { recursive: true });
    const policy = "src/policy/inquiry-policy.ts";
    writeFileSync(
      join(repo, policy),
      "export class InquiryPolicy extends AbstractPolicy {\n  sameFirm(): boolean {\n    return true;\n  }\n}\n",
    );
    const before = await ops.getNamingLexicon({ collection: "c", path: repo, files: [policy] });
    const novelBefore = before.review!.novel;

    await db.run(
      `INSERT INTO cg_symbols_inheritance
         (source_fq_name, source_rel_path, source_symbol_id, ancestor_fq_name, ancestor_symbol_id, kind, ordinal)
       VALUES ('InquiryPolicy', ?, 'InquiryPolicy', 'AbstractPolicy', 'AbstractPolicy', 'super', 0)`,
      [policy],
    );
    await db.run(
      "INSERT INTO cg_symbols (rel_path, symbol_id, fq_name, short_name, scope_json) VALUES (?, ?, ?, ?, '[]')",
      ["src/policy/abstract-policy.ts", "AbstractPolicy#sameFirm", "AbstractPolicy#sameFirm", "sameFirm"],
    );
    const after = await ops.getNamingLexicon({ collection: "c", path: repo, files: [policy] });
    expect(after.review?.novel).toBe(novelBefore - 1);
    expect(after.review?.conforming).toBe(before.review!.conforming + 1);
    expect(after.review?.findings.map((f) => f.name)).not.toContain("sameFirm");
  });

  it("diff mode needs the project's working tree", async () => {
    await expect(ops.getNamingLexicon({ collection: "c", changes: {} })).rejects.toBeInstanceOf(InvalidParameterError);
  });
});
