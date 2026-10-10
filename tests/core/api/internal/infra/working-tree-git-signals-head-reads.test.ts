/**
 * bd tea-rags-mcp-89k7k.35.23 / 89k7k.35.24 — the reads of an on-demand
 * working-tree git computation that depend on nothing but (toplevel, HEAD):
 * the repo-wide `--name-status` lifetime walk a window-less path needs, and the
 * `log -1 %ct` HEAD commit time an `anchor: head` config measures from. The
 * source reads each once per (toplevel, HEAD), not once per computation.
 * Counts, never times — load-independent. Every git child the CLI adapter
 * spawns goes through `trackGitChildProcess`.
 */
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
  type GitWorkingTreeSeedStep,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type * as childRegistry from "../../../../../src/core/adapters/vcs/git/git-cli/git-child-process-registry.js";
import { createWorkingTreeGitSignalSource } from "../../../../../src/core/api/internal/infra/working-tree-git-signals.js";
import type { WorkingTreeGitSignalTarget } from "../../../../../src/core/contracts/types/working-tree.js";

const spawnLog = vi.hoisted(() => ({ argv: [] as string[][] }));

vi.mock("../../../../../src/core/adapters/vcs/git/git-cli/git-child-process-registry.js", async (importOriginal) => {
  const actual: typeof childRegistry = await importOriginal();
  return {
    ...actual,
    trackGitChildProcess: (child: ChildProcess) => {
      spawnLog.argv.push(child.spawnargs.slice(1));
      actual.trackGitChildProcess(child);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

const C_HISTORY: GitWorkingTreeSeedStep[] = [
  { commit: { "src/cyc/c.ts": "export function cFn(n: number): number {\n  return n;\n}\n" }, message: "add c" },
];

const WINDOWED = {
  vcsAdapter: "git" as const,
  timeoutMs: 30_000,
  file: { maxAgeMonths: 12 },
  chunk: { maxAgeMonths: 6, timeoutMs: 30_000, maxFileLines: 5000, concurrency: 4 },
};

const isLifetimeWalk = (argv: string[]): boolean => argv[0] === "log" && argv.includes("--name-status");
const isHeadTimeRead = (argv: string[]): boolean =>
  argv[0] === "log" && argv.includes("-1") && argv.includes("--format=%ct");
const lifetimeWalks = (): number => spawnLog.argv.filter(isLifetimeWalk).length;
const headTimeReads = (): number => spawnLog.argv.filter(isHeadTimeRead).length;

describe("on-demand working-tree git signals — reads per (toplevel, HEAD) (89k7k.35.23, 89k7k.35.24)", () => {
  let fixture: GitWorkingTreeFixture;
  let tree: string;

  /** An untracked file: no commit in the window, so it needs the lifetime walk. */
  const untracked = (name: string): WorkingTreeGitSignalTarget => {
    writeFileSync(join(tree, `src/${name}.ts`), `export const ${name} = 1;\n`);
    return {
      relativePath: `src/${name}.ts`,
      treePath: `src/${name}.ts`,
      maxEndLine: 1,
      fileSignals: true,
      chunks: [{ key: "r", startLine: 1, endLine: 1 }],
    };
  };

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture(C_HISTORY);
    tree = fixture.mainRoot;
    spawnLog.argv.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it("two computations at one HEAD spawn the lifetime walk once", async () => {
    const source = createWorkingTreeGitSignalSource(WINDOWED);

    await source.signalsOf(tree, [untracked("a")]);
    await source.signalsOf(tree, [untracked("b")]);

    expect(lifetimeWalks()).toBe(1);
  });

  it("a new HEAD walks again", async () => {
    const source = createWorkingTreeGitSignalSource(WINDOWED);

    await source.signalsOf(tree, [untracked("a")]);
    await source.signalsOf(tree, [untracked("b")]);
    fixture.commit(tree, { "src/other.ts": "export const other = 1;\n" }, "other");
    await source.signalsOf(tree, [untracked("c")]);

    expect(lifetimeWalks()).toBe(2);
  });

  it("concurrent computations at one HEAD share one walk", async () => {
    const source = createWorkingTreeGitSignalSource(WINDOWED);

    await Promise.all([source.signalsOf(tree, [untracked("a")]), source.signalsOf(tree, [untracked("b")])]);

    expect(lifetimeWalks()).toBe(1);
  });

  it("a failed lifetime read is retried by the next computation", async () => {
    const read = vi
      .spyOn(GitCliAdapter.prototype, "readCommitPathChanges")
      .mockRejectedValueOnce(new Error("lifetime walk stalled"));
    const source = createWorkingTreeGitSignalSource(WINDOWED);

    const failed = await source.signalsOf(tree, [untracked("a")]);
    const retried = await source.signalsOf(tree, [untracked("b")]);

    expect(failed.get("src/a.ts")?.file).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    expect(retried.get("src/b.ts")?.chunks.get("r")).toMatchObject({ commitCount: 0 });
  });

  it("anchor head: the HEAD commit time is read once across two computations at one HEAD", async () => {
    const source = createWorkingTreeGitSignalSource({ ...WINDOWED, anchor: "head" });

    await source.signalsOf(tree, [untracked("a")]);
    await source.signalsOf(tree, [untracked("b")]);

    expect(headTimeReads()).toBe(1);
  });

  it("anchor head: a new HEAD reads its commit time again", async () => {
    const source = createWorkingTreeGitSignalSource({ ...WINDOWED, anchor: "head" });

    await source.signalsOf(tree, [untracked("a")]);
    fixture.commit(tree, { "src/other.ts": "export const other = 1;\n" }, "other");
    await source.signalsOf(tree, [untracked("b")]);

    expect(headTimeReads()).toBe(2);
  });
});
