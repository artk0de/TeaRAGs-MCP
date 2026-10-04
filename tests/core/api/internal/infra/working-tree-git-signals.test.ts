/**
 * `createWorkingTreeGitSignalSource` (bd tea-rags-mcp-xi2r9, D12): on-demand
 * `git.file` and `git.chunk` for working-tree delta rows no base point
 * answers, by the git trajectory's OWN computation over real git history — the
 * backfill's file signals, the chunk walk's hunk→range attribution and HEAD
 * blame ownership. A row's lines are the TREE file's; lines the working file
 * added hold no history. Cached per (toplevel, HEAD, path, line extent) for the
 * file and per (toplevel, HEAD, path, content sha, range) for a chunk.
 */
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
  type GitWorkingTreeSeedStep,
} from "../../../__helpers__/git-working-tree-fixture.js";
import * as gitCli from "../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import { createWorkingTreeGitSignalStore } from "../../../../../src/core/api/internal/infra/working-tree-git-signal-store.js";
import { createWorkingTreeGitSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-git-signals.js";
import type { WorkingTreeGitSignalTarget } from "../../../../../src/core/contracts/types/working-tree.js";
import * as onDemand from "../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js";

vi.mock("../../../../../src/core/domains/trajectory/git/infra/on-demand-signals.js", async (importOriginal) =>
  importOriginal(),
);
vi.mock("../../../../../src/core/adapters/vcs/git/git-cli/client.js", async (importOriginal) => importOriginal());

const C_V1 = "export function cFn(n: number): number {\n  return n;\n}\n";
const C_V2 = "export function cFn(n: number): number {\n  return n + 1;\n}\n";
/** `src/cyc/c.ts` committed, then fixed: two commits of its history. */
const C_HISTORY: GitWorkingTreeSeedStep[] = [
  { commit: { "src/cyc/c.ts": C_V1 }, message: "add c" },
  { commit: { "src/cyc/c.ts": C_V2 }, message: "fix: c" },
];
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
    fixture = createGitWorkingTreeFixture(C_HISTORY);
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
    // Invariant changed (round-4 P4): its `git.file` is that bare run stamp —
    // what ingest's applier writes — not nothing.
    it("answers an untracked file's rows with the chunk walk's zero block and a bare-stamp git.file", async () => {
      write("src/fresh.ts", "export const fresh = 1;\n");

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({
          relativePath: "src/fresh.ts",
          treePath: "src/fresh.ts",
          maxEndLine: 1,
          chunks: [{ key: "r", startLine: 1, endLine: 1 }],
        }),
      ]);

      expect(signals.get("src/fresh.ts")?.file).toEqual({ enrichedAt: expect.any(String) });
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

    // Invariant changed (live G4, bd tea-rags-mcp-xi2r9): ingest walks every
    // chunk of a tracked file, and a chunk no commit touched — a brand-new
    // symbol — gets the walk's zero overlay (`assembleOverlays` over an
    // accumulator no commit reached), not nothing. Its lines were never
    // committed, so no blame line attributes them: ownership is unknown.
    it("gives rows made only of uncommitted lines the chunk walk's zero block", async () => {
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
      expect(chunks?.get("fresh")).toMatchObject({
        commitCount: 0,
        churnRatio: 0,
        bugFixRate: 0,
        lastModifiedAt: 0,
        blameDominantAuthor: "unknown",
        blameDominantAuthorPct: 0,
      });
    });

    it("reads a renamed file's history at its old path and its lines at the new one", async () => {
      renameSync(join(tree, "src/cyc/c.ts"), join(tree, "src/cyc/c2.ts"));

      const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [
        target({ treePath: "src/cyc/c2.ts", fileSignals: false, chunks: [{ key: "cFn", startLine: 1, endLine: 3 }] }),
      ]);

      expect(signals.get("src/cyc/c.ts")?.chunks.get("cFn")).toMatchObject({ commitCount: 2 });
    });
  });

  // Live G1: whose history moved since the index — one git call per range.
  describe("pathsCommittedSince", () => {
    it("lists every path a commit since the stamp touched, both sides of a committed move, no uncommitted edit", async () => {
      const indexed = fixture.git(tree, "rev-parse", "HEAD").trim();
      fixture.commit(tree, { "src/new.ts": "export const n = 1;\n", "README.md": "# r\n" }, "add new");
      fixture.git(tree, "mv", "src/cyc/c.ts", "src/cyc/moved.ts");
      fixture.git(tree, "commit", "-q", "-m", "move c");
      write("src/index.ts", "export const base = 2;\n");

      const source = createWorkingTreeGitSignalSource(DEPS);

      expect(await source.pathsCommittedSince(tree, indexed)).toEqual(
        new Set(["README.md", "src/new.ts", "src/cyc/c.ts", "src/cyc/moved.ts"]),
      );
      // Relative to a root below the toplevel; a sibling directory's path is not the root's.
      expect(await source.pathsCommittedSince(join(tree, "src"), indexed)).toEqual(
        new Set(["new.ts", "cyc/c.ts", "cyc/moved.ts"]),
      );
    });

    // Live G1 on a diverged HEAD: the tree branched before the stamp, so the
    // stamp's side holds commits the tree's history lacks — their paths moved too.
    it("lists the paths either side touched when HEAD does not descend from the stamp", async () => {
      const worktree = fixture.addWorktree("old");
      fixture.commit(worktree, { "src/branch.ts": "export const b = 1;\n" }, "branch work");
      const stamp = fixture.commit(tree, { "src/cyc/c.ts": C_V1 }, "main moves c");

      expect(await createWorkingTreeGitSignalSource(DEPS).pathsCommittedSince(worktree, stamp)).toEqual(
        new Set(["src/branch.ts", "src/cyc/c.ts"]),
      );
    });

    it("answers undefined for a commit the repository does not have", async () => {
      expect(await createWorkingTreeGitSignalSource(DEPS).pathsCommittedSince(tree, "f".repeat(40))).toBeUndefined();
    });

    it("asks git once per range, and again once HEAD moves", async () => {
      const spy = vi.spyOn(gitCli, "readPathCommitsSince");
      const indexed = fixture.git(tree, "rev-parse", "HEAD").trim();
      fixture.commit(tree, { "src/new.ts": "export const n = 1;\n" });
      const source = createWorkingTreeGitSignalSource(DEPS);

      await source.pathsCommittedSince(tree, indexed);
      await source.pathsCommittedSince(tree, indexed);
      expect(spy).toHaveBeenCalledTimes(1);

      fixture.commit(tree, { "src/later.ts": "export const l = 1;\n" });
      expect(await source.pathsCommittedSince(tree, indexed)).toEqual(new Set(["src/new.ts", "src/later.ts"]));
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  // Live G2: every `tea-rags call` is a fresh process, and a cold find_symbol
  // on a 159-file delta spawned 136 blames + 137 cat-files each time.
  describe("persistent store", () => {
    let storeRoot: string;
    beforeEach(() => {
      storeRoot = mkdtempSync(join(tmpdir(), "wt-git-signals-"));
    });
    afterEach(() => {
      rmSync(storeRoot, { recursive: true, force: true });
    });

    const persistent = (overrides: { builderVersion?: string; now?: () => number } = {}) =>
      createWorkingTreeGitSignalSource({
        ...DEPS,
        store: createWorkingTreeGitSignalStore({ rootDir: storeRoot }),
        builderVersion: "1.0.0",
        ...overrides,
      });
    const ask = () => [
      target({
        maxEndLine: 7,
        chunks: [
          { key: "cFn", startLine: 1, endLine: 3 },
          { key: "fresh", startLine: 5, endLine: 7 },
        ],
      }),
    ];

    it("answers a second process from the store, computing nothing for unchanged inputs", async () => {
      appendFileSync(join(tree, "src/cyc/c.ts"), FRESH);
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");

      const first = await persistent().signalsOf(tree, ask());
      const second = await persistent().signalsOf(tree, ask());

      expect(spy).toHaveBeenCalledTimes(1);
      expect(second.get("src/cyc/c.ts")?.file).toEqual(first.get("src/cyc/c.ts")?.file);
      expect([...(second.get("src/cyc/c.ts")?.chunks ?? [])]).toEqual([...(first.get("src/cyc/c.ts")?.chunks ?? [])]);
      expect(second.get("src/cyc/c.ts")?.chunks.get("fresh")).toMatchObject({ commitCount: 0 });
    });

    it("recomputes when the tree content, the signal builder, or the day differs", async () => {
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");
      const day = 86_400_000;
      const t0 = Date.now();

      await persistent({ now: () => t0 }).signalsOf(tree, ask());
      await persistent({ now: () => t0, builderVersion: "1.0.1" }).signalsOf(tree, ask());
      await persistent({ now: () => t0 + day }).signalsOf(tree, ask());
      appendFileSync(join(tree, "src/cyc/c.ts"), FRESH);
      await persistent({ now: () => t0 }).signalsOf(tree, ask());

      expect(spy).toHaveBeenCalledTimes(4);
    });
  });

  // Live C2: records keyed by HEAD made every commit invalidate every file — the
  // first cold call after a commit re-blamed all 159 delta files. A path's
  // blocks depend only on the commits that touched it.
  describe("records scoped to each path's own history since the index", () => {
    let storeRoot: string;
    let indexed: string;
    beforeEach(() => {
      storeRoot = mkdtempSync(join(tmpdir(), "wt-git-history-"));
      // The outer repository plus "add d", built once and copied.
      fixture.cleanup();
      fixture = createGitWorkingTreeFixture([
        ...C_HISTORY,
        { commit: { "src/d.ts": "export const d = 1;\n" }, message: "add d" },
      ]);
      tree = fixture.mainRoot;
      [, , indexed] = fixture.seeded.commits;
    });
    afterEach(() => {
      rmSync(storeRoot, { recursive: true, force: true });
    });

    const persistent = () =>
      createWorkingTreeGitSignalSource({
        ...DEPS,
        store: createWorkingTreeGitSignalStore({ rootDir: storeRoot }),
        builderVersion: "1.0.0",
      });
    const both = (): WorkingTreeGitSignalTarget[] => [
      target({ chunks: [{ key: "cFn", startLine: 1, endLine: 3 }] }),
      target({ relativePath: "src/d.ts", treePath: "src/d.ts", maxEndLine: 1 }),
    ];
    const computedPaths = (spy: { mock: { calls: unknown[][] } }, call: number): string[] =>
      (spy.mock.calls[call][1] as { relPath: string }[]).map((t) => t.relPath);

    it("keeps another file's record a hit across a commit that touched one file, in a new process", async () => {
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");
      await persistent().signalsOf(tree, both(), indexed);

      fixture.commit(tree, { "src/cyc/c.ts": "export function cFn(n: number): number {\n  return n + 2;\n}\n" });
      const after = await persistent().signalsOf(tree, both(), indexed);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(computedPaths(spy, 1)).toEqual(["src/cyc/c.ts"]);
      expect(after.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 3 });
      expect(after.get("src/cyc/c.ts")?.chunks.get("cFn")).toMatchObject({ commitCount: 3 });
      expect(after.get("src/d.ts")?.file).toMatchObject({ commitCount: 1 });
    });

    it("keeps a record a hit while HEAD moves on through commits that touch other files", async () => {
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");
      fixture.commit(tree, { "src/cyc/c.ts": "export function cFn(n: number): number {\n  return n + 2;\n}\n" });
      await persistent().signalsOf(tree, both(), indexed);

      fixture.commit(tree, { "src/e.ts": "export const e = 1;\n" });
      await persistent().signalsOf(tree, both(), indexed);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("recomputes a path a later commit touched again", async () => {
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");
      fixture.commit(tree, { "src/d.ts": "export const d = 2;\n" });
      await persistent().signalsOf(tree, both(), indexed);

      fixture.commit(tree, { "src/d.ts": "export const d = 3;\n" });
      const after = await persistent().signalsOf(tree, both(), indexed);

      expect(computedPaths(spy, 1)).toEqual(["src/d.ts"]);
      expect(after.get("src/d.ts")?.file).toMatchObject({ commitCount: 3 });
    });

    it("does not answer a HEAD that lacks a commit of the stamp's history from the stamp's record", async () => {
      await persistent().signalsOf(tree, both(), indexed);

      // A branch off the commit before "add d": its d.ts history is empty.
      fixture.git(tree, "checkout", "-q", "-b", "side", `${indexed}~1`);
      fixture.commit(tree, { "src/e.ts": "export const e = 1;\n" });
      const after = await persistent().signalsOf(tree, both(), indexed);

      // No history on this HEAD: the bare stamp (round-4 P4), never the stamp's record.
      expect(after.get("src/d.ts")?.file).toEqual({ enrichedAt: expect.any(String) });
      expect(after.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 2 });
    });

    it("recomputes a committed move's record when the history behind the move differs", async () => {
      const spy = vi.spyOn(onDemand, "buildOnDemandGitSignals");
      fixture.git(tree, "mv", "src/cyc/c.ts", "src/cyc/moved.ts");
      fixture.git(tree, "commit", "-q", "-m", "move c");
      const moved = [target({ relativePath: "src/cyc/moved.ts", treePath: "src/cyc/moved.ts" })];
      await persistent().signalsOf(tree, moved, indexed);
      expect(spy).toHaveBeenCalledTimes(1);

      // Same tree, a history that holds one more commit on the old side of the move.
      fixture.git(tree, "reset", "-q", "--hard", indexed);
      fixture.commit(tree, { "src/cyc/c.ts": "export function cFn(n: number): number {\n  return n + 3;\n}\n" });
      fixture.git(tree, "mv", "src/cyc/c.ts", "src/cyc/moved.ts");
      fixture.git(tree, "commit", "-q", "-m", "move c");
      writeFileSync(join(tree, "src/cyc/moved.ts"), "export function cFn(n: number): number {\n  return n + 1;\n}\n");
      fixture.git(tree, "commit", "-q", "-am", "restore body");
      const after = await persistent().signalsOf(tree, moved, indexed);

      expect(spy).toHaveBeenCalledTimes(2);
      expect(after.get("src/cyc/moved.ts")?.file).toMatchObject({ commitCount: 5 });
    });
  });

  // Round-4 P1: the blocks are the ones a reindex of the tree would write WITH
  // THE INDEX'S OWN CONFIG — its project's registry env, not whatever env the
  // serving process was started with. A server without the self-index's
  // `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS=true` recomputed `symbol.ts` at 20
  // commits beside base rows counting 19 sessions: one answer, two units.
  describe("the configuration of the index the tree is read against", () => {
    const SQUASHED = { ...DEPS, squashOpts: { squashAwareSessions: true, sessionGapMinutes: 30 } };

    it("computes a path with the git config of the index it serves, each index its own", async () => {
      // c.ts: two commits by one author seconds apart — one session, two commits.
      const source = createWorkingTreeGitSignalSource({
        ...DEPS,
        configFor: (indexRoot) => (indexRoot === "/index/squashed" ? SQUASHED : undefined),
      });

      const squashed = await source.signalsOf(tree, [target()], undefined, "/index/squashed");
      const plain = await source.signalsOf(tree, [target()], undefined, "/index/plain");

      expect(squashed.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 1 });
      expect(plain.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 2 });
    });

    it("keeps a stored record of one config from answering another", async () => {
      const storeRoot = mkdtempSync(join(tmpdir(), "wt-git-config-"));
      try {
        const persistent = () =>
          createWorkingTreeGitSignalSource({
            ...DEPS,
            store: createWorkingTreeGitSignalStore({ rootDir: storeRoot }),
            builderVersion: "1.0.0",
            configFor: (indexRoot) => (indexRoot === "/index/squashed" ? SQUASHED : undefined),
          });

        await persistent().signalsOf(tree, [target()], undefined, "/index/plain");
        const squashed = await persistent().signalsOf(tree, [target()], undefined, "/index/squashed");

        expect(squashed.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 1 });
      } finally {
        rmSync(storeRoot, { recursive: true, force: true });
      }
    });

    // Ingest's file walk is the windowed repo-wide discovery
    // (`TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS`); a path it finds nothing for reads
    // the zero observation, with its age stamps from the whole history (bd
    // tea-rags-mcp-i6tkc — it used to be backfilled with lifetime counters).
    it("reads git.file over the file walk's window, and a path with nothing in it as a zero observation with exact age", async () => {
      const dated = (iso: string, files: Record<string, string>): void => {
        vi.stubEnv("GIT_AUTHOR_DATE", iso);
        vi.stubEnv("GIT_COMMITTER_DATE", iso);
        try {
          fixture.commit(tree, files);
        } finally {
          vi.unstubAllEnvs();
        }
      };
      const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
      dated(longAgo, { "src/mixed.ts": "export const m = 1;\n", "src/old.ts": "export const o = 1;\n" });
      dated(longAgo, { "src/old.ts": "export const o = 2;\n" });
      fixture.commit(tree, { "src/mixed.ts": "export const m = 2;\n" });
      const windowed = createWorkingTreeGitSignalSource({ ...DEPS, file: { maxAgeMonths: 12 } });

      const signals = await windowed.signalsOf(tree, [
        target({ relativePath: "src/mixed.ts", treePath: "src/mixed.ts", maxEndLine: 1 }),
        target({ relativePath: "src/old.ts", treePath: "src/old.ts", maxEndLine: 1 }),
      ]);

      expect(signals.get("src/mixed.ts")?.file).toMatchObject({ commitCount: 1 });
      expect(signals.get("src/old.ts")?.file).toMatchObject({
        commitCount: 0,
        lastModifiedAt: Math.floor(Date.parse(longAgo) / 1000),
      });
      expect(signals.get("src/old.ts")?.file).not.toHaveProperty("bugFixRate");
    });
  });

  // Round-4 P4: ingest's applier stamps every block it writes with the run's
  // `enrichedAt`, and a file it found no history for with the bare stamp.
  describe("enrichedAt", () => {
    it("stamps every computed block with the computation time, and a path with no history with the bare stamp", async () => {
      const at = Date.UTC(2026, 9, 3, 12);
      const stamp = new Date(at).toISOString();
      appendFileSync(join(tree, "src/cyc/c.ts"), FRESH);
      write("src/untracked.ts", "export const u = 1;\n");

      const signals = await createWorkingTreeGitSignalSource({ ...DEPS, now: () => at }).signalsOf(tree, [
        target({
          maxEndLine: 7,
          chunks: [
            { key: "cFn", startLine: 1, endLine: 3 },
            { key: "fresh", startLine: 5, endLine: 7 },
          ],
        }),
        target({
          relativePath: "src/untracked.ts",
          treePath: "src/untracked.ts",
          maxEndLine: 1,
          chunks: [{ key: "u", startLine: 1, endLine: 1 }],
        }),
      ]);

      const committed = signals.get("src/cyc/c.ts");
      expect(committed?.file).toMatchObject({ commitCount: 2, enrichedAt: stamp });
      expect(committed?.chunks.get("cFn")).toMatchObject({ commitCount: 2, enrichedAt: stamp });
      expect(committed?.chunks.get("fresh")).toMatchObject({ commitCount: 0, enrichedAt: stamp });
      expect(signals.get("src/untracked.ts")?.file).toEqual({ enrichedAt: stamp });
      expect(signals.get("src/untracked.ts")?.chunks.get("u")).toMatchObject({ commitCount: 0, enrichedAt: stamp });
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
