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
import { NamingLexiconOps } from "../../../../../src/core/api/internal/ops/naming-lexicon-ops.js";
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

  function build(): NamingLexiconOps {
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
    // A generic name is a finding even when it conforms.
    expect(review?.findings).toContainEqual(
      expect.objectContaining({ name: "result", line: 9, verdict: "CONFORMS", genericName: { typeCount: 6, n: 16 } }),
    );
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
    expect(result.review?.findings.map((f) => f.name).sort()).toEqual(["Commit", "meta", "result"]);
  });

  it("an untracked file is reviewed whole", async () => {
    writeFileSync(join(repo, "src/git/fresh.ts"), "// one\n// two\nexport class Commit {}\n");
    const result = await ops.getNamingLexicon({ collection: "c", path: repo, files: ["src/git/fresh.ts"] });
    expect(result.review?.findings).toEqual([
      expect.objectContaining({ relPath: "src/git/fresh.ts", line: 3, name: "Commit", verdict: "COLLISION" }),
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

  it("diff mode needs the project's working tree", async () => {
    await expect(ops.getNamingLexicon({ collection: "c", changes: {} })).rejects.toBeInstanceOf(InvalidParameterError);
  });
});
