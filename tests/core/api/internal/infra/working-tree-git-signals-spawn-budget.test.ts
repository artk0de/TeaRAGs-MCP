/**
 * bd tea-rags-mcp-89k7k.35.22 — the git spawn budget of one on-demand
 * working-tree git computation. Process creation, not git's own work, is what
 * a computation costs (>95 % of its wall clock at load), so the spawn LIST is
 * the contract pinned here — counts, never times, load-independent:
 * - the numstat log learns add/delete commits from its own `--summary` (no
 *   `--diff-filter=AD` log);
 * - with a file window that contains the chunk window, the chunk walk's
 *   commits are sliced from the file walk's read (no chunk-window log);
 * - HEAD comes from the caller (no `rev-parse`);
 * - one blob reader serves the HEAD carry and the walk (one `cat-file`), and
 *   it is spawned only when a blob is read.
 * Every git child the CLI adapter spawns goes through `trackGitChildProcess`.
 */
import type { ChildProcess } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  prebuildGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
  type GitWorkingTreeSeedStep,
} from "../../../__helpers__/git-working-tree-fixture.js";
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

const C_V1 = "export function cFn(n: number): number {\n  return n;\n}\n";
const C_V2 = "export function cFn(n: number): number {\n  return n + 1;\n}\n";
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
const WINDOWED = { ...DEPS, file: { maxAgeMonths: 12 } };

/** The git subcommand of a spawn, past any `-c key=value` / `-C dir` prefix. */
function subcommandOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "-c" || argv[i] === "-C") {
      i++;
      continue;
    }
    if (!argv[i].startsWith("-")) return argv[i];
  }
  return undefined;
}

const spawnsOf = (subcommand: string): string[][] => spawnLog.argv.filter((argv) => subcommandOf(argv) === subcommand);
const hasArg = (argv: string[], prefix: string): boolean => argv.some((arg) => arg.startsWith(prefix));

describe("on-demand working-tree git signals — git spawn budget (89k7k.35.22)", () => {
  let fixture: GitWorkingTreeFixture;
  let tree: string;

  const target = (overrides: Partial<WorkingTreeGitSignalTarget> = {}): WorkingTreeGitSignalTarget => ({
    relativePath: "src/cyc/c.ts",
    treePath: "src/cyc/c.ts",
    maxEndLine: 7,
    fileSignals: true,
    chunks: [
      { key: "cFn", startLine: 1, endLine: 3 },
      { key: "fresh", startLine: 5, endLine: 7 },
    ],
    ...overrides,
  });

  // Pay the git template recipe here, not inside the first test's 30 s beforeEach budget (bd 723i6).
  beforeAll(() => {
    prebuildGitWorkingTreeFixture(C_HISTORY);
  });

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture(C_HISTORY);
    tree = fixture.mainRoot;
    // One row carried onto HEAD (cFn), one made only of uncommitted lines (fresh).
    appendFileSync(join(tree, "src/cyc/c.ts"), FRESH);
    spawnLog.argv.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixture.cleanup();
  });

  it("windowed: one numstat log, one add re-read, one blame, one blob reader — nothing else", async () => {
    const signals = await createWorkingTreeGitSignalSource(WINDOWED).signalsOf(tree, [target()]);

    expect(signals.get("src/cyc/c.ts")?.chunks.get("cFn")).toMatchObject({ commitCount: 2 });
    expect(signals.get("src/cyc/c.ts")?.file).toMatchObject({ commitCount: 2 });
    const subcommands = spawnLog.argv.map(subcommandOf).sort();
    expect(subcommands).toEqual(["blame", "cat-file", "log", "log"]);
    const [numstat, reread] = spawnsOf("log");
    expect(numstat).toEqual(expect.arrayContaining(["--numstat", "--summary", "--full-history"]));
    expect(reread).toEqual(expect.arrayContaining(["--no-walk=unsorted"]));
    expect(spawnsOf("cat-file")).toEqual([expect.arrayContaining(["--batch"])]);
  });

  it("windowed: no rev-parse, no --diff-filter log, no log over the chunk window", async () => {
    await createWorkingTreeGitSignalSource(WINDOWED).signalsOf(tree, [target()]);

    expect(spawnsOf("rev-parse")).toEqual([]);
    expect(spawnLog.argv.filter((argv) => hasArg(argv, "--diff-filter"))).toEqual([]);
    const sinces = new Set(spawnsOf("log").flatMap((argv) => argv.filter((arg) => arg.startsWith("--since="))));
    expect(sinces.size).toBe(1);
  });

  it("no file window: no rev-parse, no --diff-filter log, one blob reader, two logs per walk", async () => {
    const signals = await createWorkingTreeGitSignalSource(DEPS).signalsOf(tree, [target()]);

    expect(signals.get("src/cyc/c.ts")?.chunks.get("cFn")).toMatchObject({ commitCount: 2 });
    expect(spawnsOf("rev-parse")).toEqual([]);
    expect(spawnLog.argv.filter((argv) => hasArg(argv, "--diff-filter"))).toEqual([]);
    expect(spawnsOf("cat-file")).toHaveLength(1);
    // Whole-history file walk and chunk-window walk (the two windows differ, so
    // nothing is shared): each one numstat log plus the add re-read.
    const logs = spawnsOf("log");
    expect(logs).toHaveLength(4);
    expect(logs.filter((argv) => hasArg(argv, "--since="))).toHaveLength(1);
  });

  it("windowed with an untracked file: its chunk walk reads no log of its own", async () => {
    writeFileSync(join(tree, "src/fresh.ts"), "export const fresh = 1;\n");

    const signals = await createWorkingTreeGitSignalSource(WINDOWED).signalsOf(tree, [
      target(),
      target({
        relativePath: "src/fresh.ts",
        treePath: "src/fresh.ts",
        maxEndLine: 1,
        chunks: [{ key: "r", startLine: 1, endLine: 1 }],
      }),
    ]);

    expect(signals.get("src/fresh.ts")?.chunks.get("r")).toMatchObject({ commitCount: 0 });
    const logs = spawnsOf("log");
    // The windowed numstat log over both paths, the add re-read, and the
    // whole-history lifetime walk the window-less untracked path triggers.
    expect(logs).toHaveLength(3);
    expect(logs.filter((argv) => hasArg(argv, "--since="))).toHaveLength(1);
    expect(spawnsOf("cat-file")).toHaveLength(1);
    expect(spawnsOf("rev-parse")).toEqual([]);
  });

  it("spawns no blob reader when no blob is read", async () => {
    writeFileSync(join(tree, "src/fresh.ts"), "export const fresh = 1;\n");

    await createWorkingTreeGitSignalSource(WINDOWED).signalsOf(tree, [
      target({
        relativePath: "src/fresh.ts",
        treePath: "src/fresh.ts",
        maxEndLine: 1,
        fileSignals: false,
        chunks: [{ key: "r", startLine: 1, endLine: 1 }],
      }),
    ]);

    expect(spawnsOf("cat-file")).toEqual([]);
  });
});
