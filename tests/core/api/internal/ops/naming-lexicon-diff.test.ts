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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../../src/core/adapters/duckdb/client.js";
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

  function build(embeddings?: NamingLexiconEmbeddings, collectionRegistry: unknown = {}): NamingLexiconOps {
    const graphDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "close") return async () => undefined;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return new NamingLexiconOps({
      pool: { acquireReader: vi.fn(async () => ({ graphDb, symbolTable: {} })) } as never,
      collectionRegistry: collectionRegistry as never,
      resolveActiveCollection: async (name: string) => name as never,
      explore: { semanticSearch },
      namingConventions: NAMING,
      ontologyLanguages: ontologyLanguageProfiles(),
      extractDeclarations: createNamingReviewExtractor(new LanguageFactory({})),
      ...(embeddings !== undefined ? { embeddings } : {}),
    });
  }

  beforeEach(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "naming-lexicon-diff-")));
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

  // bd tea-rags-mcp-89k7k.15: the DTO barrel re-exporting the declaring file's surface is the SAME
  // declaration — the pair is no collision; a twin no edge forwards still is.
  it("a barrel re-exporting the draft's name out of its file is no collision; an independent twin still is", async () => {
    writeFileSync(join(repo, "src/git/widget.ts"), "export class Widget {}\n");
    // The barrel's alias row, as the codegraph indexes a `export { Widget } from ...` surface.
    await db.replaceTypeDeclarationsBulk([{ relPath: "src/dto/widgets.ts", rows: [decl("Widget", "class")] }]);
    await db.run(
      "INSERT INTO cg_symbols_edges_file (source_rel_path, target_rel_path, reexported_export_names) VALUES (?, ?, ?)",
      ["src/dto/widgets.ts", "src/git/widget.ts", "Widget"],
    );
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
    const names = result.review?.findings.map((f) => f.name) ?? [];
    expect(names).not.toContain("Widget");
    // The guard: `Commit` (src/vcs/commit.ts) is declared by no forwarded edge — still a COLLISION.
    expect(result.review?.findings).toContainEqual(
      expect.objectContaining({
        name: "Commit",
        verdict: "COLLISION",
        existing: { symbolId: "Commit", relPath: "src/vcs/commit.ts" },
      }),
    );
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
    // Spec D4 (bd tea-rags-mcp-0qaht): the untyped function `g` is judged by method vocabulary too — novel.
    expect(result.review?.novel).toBe(2);
    expect(result.review?.checked).toBe(2);
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
    // Spec 2026-09-28 §D4: a method with no known return type is judged by the method vocabulary.
    it("a method with no known return type is judged, not listed; a constructor is neither", async () => {
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
      expect(review?.notJudgedBy).toBeUndefined();
      expect(review?.notJudgedNames).toBeUndefined();
      // `perform` is verbless and declared nowhere else: novel, never a finding; `initialize` is no draft.
      expect(review?.findings.map((f) => f.name)).not.toContain("perform");
      expect(review?.findings.map((f) => f.name)).not.toContain("initialize");
      expect(review?.novel).toBeGreaterThanOrEqual(1);
      // Declarations stay the only thing `notJudged` does not count: it counts files.
      expect(review?.notJudged).toBe(0);
    });

    // Live on taxdome: a `module_function` method is one declaration under two symbols (`M#x`, `M.x`).
    it("a method declared once under two symbols is judged once", async () => {
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
      expect(review?.notJudgedBy).toBeUndefined();
      // The file's two value drafts and `refuse!` once, not once per symbol.
      expect(review?.checked).toBe(3);
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
      mkdirSync(join(repo, "src/many"), { recursive: true });
      const files = Array.from({ length: 60 }, (_, i) => `src/many/step-${i}.test.ts`);
      for (const relPath of files) writeFileSync(join(repo, relPath), "export const x = 1;\n");
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, files });
      expect(review?.notJudgedBy).toEqual({ file: { nonProduction: 60 } });
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

  // Lexicon friction F1: a project alias resolves to the MAIN checkout, so a change made in a
  // linked worktree was reviewed as `changedFiles: 0` — success-shaped and blind.
  describe("the working tree the review reads", () => {
    /** `project` addresses the index, registered at the main checkout; `path` names the tree. */
    const aliased = () =>
      build(undefined, {
        findByName: (name: string) => (name === "p" ? { name: "p", collectionName: "c", path: repo } : null),
        list: () => [],
      });

    function addWorkTree(): string {
      git(repo, "commit", "-q", "-am", "change");
      const tree = join(dir, "wt");
      git(repo, "worktree", "add", "-q", "-b", "feature", tree);
      writeFileSync(
        join(tree, "src/git/extra.ts"),
        "export function more(): void {\n  const blob: GitFileSignals = read();\n  use(blob);\n}\n",
      );
      return realpathSync(tree);
    }

    it("names the tree it read", async () => {
      const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(review?.workTree).toBe(repo);
    });

    it("an alias alone reads the main checkout the alias is registered at", async () => {
      const { review } = await aliased().getNamingLexicon({ project: "p", changes: {} });
      expect(review?.workTree).toBe(repo);
    });

    it("an empty diff says what it could not see — never a bare changedFiles: 0", async () => {
      const tree = addWorkTree();
      const result = await aliased().getNamingLexicon({ project: "p", changes: {} });
      expect(result.review?.changedFiles).toBe(0);
      const notice = (result.notices ?? []).find((n) => n.startsWith("no changes"));
      expect(notice).toBeDefined();
      expect(notice).toContain("changes.base");
      expect(notice).toContain("path");
      expect(notice).toContain(tree);
    });
  });

  // Lexicon friction F4: the changed file is out of the evidence, so only the review knows a helper
  // interface sits beside its file's primary class — and a helper is no member of the directory's role.
  it("a helper declaration beside its file's primary is not held to the directory's role", async () => {
    await db.replaceTypeDeclarationsBulk(
      ["indexing", "search", "collection"].map((stem) => ({
        relPath: `src/ops/${stem}-ops.ts`,
        rows: [decl(`${stem[0].toUpperCase()}${stem.slice(1)}Ops`, "class")],
      })),
    );
    mkdirSync(join(repo, "src/ops"), { recursive: true });
    writeFileSync(
      join(repo, "src/ops/billing-ops.ts"),
      "export class BillingOps {}\nexport interface ModelInfo {\n  id: number;\n}\nexport class InvoiceMaker {}\n",
    );
    writeFileSync(join(repo, "src/ops/refund.ts"), "export class RefundMaker {}\n");
    const { review } = await ops.getNamingLexicon({ collection: "c", path: repo, changes: {} });
    const misfits = review?.findings.filter((f) => f.verdict === "MISFIT").map((f) => f.name);
    expect(misfits).not.toContain("ModelInfo");
    expect(misfits).not.toContain("InvoiceMaker");
    // The only declaration of its file is its primary: still held.
    expect(misfits).toContain("RefundMaker");
  });

  // Lexicon friction F2: evidence read from an index built at another commit is marked, not silent.
  describe("index lag", () => {
    const registryAt = (indexedCommit: string) => ({ get: () => ({ git: { indexedCommit } }) });

    it("marks the answer when the index was built at another commit than the tree's HEAD", async () => {
      const lagging = build(undefined, registryAt("0".repeat(40)));
      const result = await lagging.getNamingLexicon({ collection: "c", path: repo, changes: {} });
      expect(result.indexLag).toEqual({
        indexedCommit: "0".repeat(40),
        treeCommit: git(repo, "rev-parse", "HEAD").trim(),
      });
    });

    it("carries no mark when the index is at the tree's HEAD", async () => {
      const fresh = build(undefined, registryAt(git(repo, "rev-parse", "HEAD").trim()));
      const result = await fresh.getNamingLexicon({
        collection: "c",
        path: repo,
        names: [{ name: "meta", type: "GitFileSignals" }],
      });
      expect(result.indexLag).toBeUndefined();
    });
  });
});
