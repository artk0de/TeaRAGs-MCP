/**
 * `createWorkingTreeGitSignalSource` (bd tea-rags-mcp-xi2r9, D12): on-demand
 * `git.file` and `git.chunk` for working-tree delta rows no base point
 * answers, by the git trajectory's OWN computation over real git history — the
 * backfill's file signals, the chunk walk's hunk→range attribution and HEAD
 * blame ownership. A row's lines are the TREE file's; lines the working file
 * added hold no history. Cached per (toplevel, HEAD, path, line extent) for the
 * file and per (toplevel, HEAD, path, content sha, range) for a chunk.
 */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { createWorkingTreeGitSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-git-signals.js";
import type { WorkingTreeGitSignalTarget } from "../../../../../src/core/contracts/types/working-tree.js";
import * as onDemand from "../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js";

vi.mock("../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js", async (importOriginal) =>
  importOriginal(),
);

const C_V1 = "export function cFn(n: number): number {\n  return n;\n}\n";
const C_V2 = "export function cFn(n: number): number {\n  return n + 1;\n}\n";
const FRESH = "\nexport function fresh(): number {\n  return 0;\n}\n";

const DEPS = {
  vcsAdapter: "git" as const,
  timeoutMs: 30_000,
  chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
};

describe("createWorkingTreeGitSignalSource", () => {
  let fixture: GitWorkingTreeFixture;
  let tree: string;

  const write = (relativePath: string, content: string): void => {
    const target = join(tree, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const target = (overrides: Partial<WorkingTreeGitSignalTarget> = {}): WorkingTreeGitSignalTarget => ({
    relativePath: "src/cyc/c.ts",
    treePath: "src/cyc/c.ts",
    maxEndLine: 3,
    fileSignals: true,
    chunks: [],
    ...overrides,
  });

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    fixture.commit(fixture.mainRoot, { "src/cyc/c.ts": C_V1 }, "add c");
    fixture.commit(fixture.mainRoot, { "src/cyc/c.ts": C_V2 }, "fix: c");
    tree = fixture.mainRoot;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  describe("git.file", () => {
    it("computes git.file of a committed file from its history and blame", async () => {
      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [target()]);

      const file = signals.get("src/cyc/c.ts")?.file;
      expect(file).toMatchObject({ commitCount: 2, blameDominantAuthor: "t", blameDominantAuthorPct: 100 });
      expect(file?.lastModifiedAt).toEqual(expect.any(Number));
    });

    it("follows the history of a file renamed in a commit", async () => {
      fixture.git(tree, "mv", "src/cyc/c.ts", "src/cyc/moved.ts");
      fixture.git(tree, "commit", "-q", "-m", "move c");

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({ relativePath: "src/cyc/moved.ts", treePath: "src/cyc/moved.ts" }),
      ]);

      expect(signals.get("src/cyc/moved.ts")?.file).toMatchObject({ commitCount: 3 });
    });

    // Invariant changed (live round-3 D4): ingest, indexing an untracked file in
    // the alias's own checkout, finds no file history (`git.file` gets only the
    // run's `enrichedAt` stamp) but WALKS its chunks and writes the walk's zero
    // overlay — `assembleOverlays` over an accumulator no commit touched. The
    // tree's rows of such a file get the same chunk block, by the same walk.
    it("answers an untracked file's rows with the chunk walk's zero block and no git.file", async () => {
      write("src/fresh.ts", "export const fresh = 1;\n");

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({
          relativePath: "src/fresh.ts",
          treePath: "src/fresh.ts",
          maxEndLine: 1,
          chunks: [{ key: "r", startLine: 1, endLine: 1 }],
        }),
      ]);

      expect(signals.get("src/fresh.ts")?.file).toBeUndefined();
      expect(signals.get("src/fresh.ts")?.chunks.get("r")).toMatchObject({
        commitCount: 0,
        churnRatio: 0,
        bugFixRate: 0,
        lastModifiedAt: 0,
        blameDominantAuthor: "unknown",
        blameDominantAuthorPct: 0,
        blameAuthors: [],
        blameContributorCount: 0,
      });
    });

    it("answers nothing for an untracked file past the chunk walk's line limit, as ingest walks none of it", async () => {
      write("src/huge.ts", "export const huge = 1;\n".repeat(20));

      const signals = await createWorkingTreeGitSignalSource({
        ...DEPS,
        chunk: { ...DEPS.chunk, maxFileLines: 10 },
      }).signalsOf(tree, [
        target({
          relativePath: "src/huge.ts",
          treePath: "src/huge.ts",
          maxEndLine: 20,
          chunks: [{ key: "r", startLine: 1, endLine: 20 }],
        }),
      ]);

      expect(signals.get("src/huge.ts")?.chunks.size ?? 0).toBe(0);
    });

    it("names paths relative to a tree root below the git toplevel", async () => {
      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(join(tree, "src"), [
        target({ relativePath: "cyc/c.ts", treePath: "cyc/c.ts" }),
      ]);

      expect(signals.get("cyc/c.ts")?.file).toMatchObject({ commitCount: 2 });
    });
  });

  describe("git.chunk", () => {
    it("attributes the commits that changed a row's lines, in the TREE file's coordinates", async () => {
      // Two uncommitted header lines push cFn to working rows 3-5 (HEAD rows 1-3).
      write("src/cyc/c.ts", `// header\n// header 2\n${C_V2}`);

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({ maxEndLine: 5, fileSignals: false, chunks: [{ key: "cFn", startLine: 3, endLine: 5 }] }),
      ]);

      const answer = signals.get("src/cyc/c.ts");
      expect(answer?.file).toBeUndefined();
      expect(answer?.chunks.get("cFn")).toMatchObject({
        commitCount: 2,
        bugFixRate: 50,
        blameDominantAuthor: "t",
        blameDominantAuthorPct: 100,
      });
    });

    it("gives rows made only of uncommitted lines no chunk block", async () => {
      appendFileSync(join(tree, "src/cyc/c.ts"), FRESH);

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({
          maxEndLine: 7,
          chunks: [
            { key: "cFn", startLine: 1, endLine: 3 },
            { key: "fresh", startLine: 5, endLine: 7 },
          ],
        }),
      ]);

      const chunks = signals.get("src/cyc/c.ts")?.chunks;
      expect(chunks?.get("cFn")).toMatchObject({ commitCount: 2 });
      expect(chunks?.has("fresh")).toBe(false);
    });

    it("reads a renamed file's history at its old path and its lines at the new one", async () => {
      renameSync(join(tree, "src/cyc/c.ts"), join(tree, "src/cyc/c2.ts"));

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({ treePath: "src/cyc/c2.ts", fileSignals: false, chunks: [{ key: "cFn", startLine: 1, endLine: 3 }] }),
      ]);

      expect(signals.get("src/cyc/c.ts")?.chunks.get("cFn")).toMatchObject({ commitCount: 2 });
    });
  });

  describe("cache", () => {
    it("reads git once per path at one HEAD and content, and again once either moves", async () => {
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");
      const source = createWorkingTreeGitSignalSource(DEPS);
      const ask = [target({ chunks: [{ key: "cFn", startLine: 1, endLine: 3 }] })];

      await source.signalsOf(tree, ask);
      await source.signalsOf(tree, ask);
      expect(spy).toHaveBeenCalledTimes(1);

      appendFileSync(join(tree, "src/cyc/c.ts"), FRESH);
      await source.signalsOf(tree, ask);
      expect(spy).toHaveBeenCalledTimes(2);

      fixture.commit(tree, { "src/cyc/c.ts": "export function cFn(n: number): number {\n  return n + 2;\n}\n" });
      const after = await source.signalsOf(tree, ask);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(after.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 3 });
      expect(after.get("src/cyc/c.ts")?.chunks.get("cFn")).toMatchObject({ commitCount: 3 });
    });
  });
});
