/**
 * bd tea-rags-mcp-89k7k.35.22 S1 — `readCommitFileNumstatForPaths` learns which
 * commits created or deleted a named path from `--summary` on its own numstat
 * log (`create mode` / `delete mode` lines) instead of a separate
 * `--diff-filter=AD` log: one git spawn fewer per read, the same answer.
 *
 * The oracle for the answer is the pre-change algorithm, run here over raw git:
 * pathspec numstat log, `--diff-filter=AD` log, `--no-walk` unrestricted re-read
 * of those commits with their rows kept when either side names a queried path.
 */

import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory } from "../../../../__helpers__/git-history-import.js";
import type * as childRegistry from "../../../../../../src/core/adapters/vcs/git/git-cli/git-child-process-registry.js";
import { readCommitFileNumstatForPaths } from "../../../../../../src/core/adapters/vcs/git/git-cli/history.js";
import {
  parseAddOrDeleteShas,
  parseCommitFileNumstat,
} from "../../../../../../src/core/adapters/vcs/git/git-cli/parsers.js";
import type { CommitFileNumstat } from "../../../../../../src/core/adapters/vcs/types.js";

const spawnLog = vi.hoisted(() => ({ argv: [] as string[][] }));

vi.mock("../../../../../../src/core/adapters/vcs/git/git-cli/git-child-process-registry.js", async (importOriginal) => {
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

const FORMAT = "--format=%x00%H%x00%P%x00%aN%x00%aE%x00%at%x00%ct%x00%B%x00";
const SHA = (c: string): string => c.repeat(40);

/** One `NUMSTAT_LOG_FORMAT_WITH_COMMITTER` commit section whose diff block is `lines`. */
function section(sha: string, lines: string[], parents = SHA("f")): string {
  return [
    "",
    sha,
    parents,
    "Alice",
    "alice@ex.com",
    "1700000000",
    "1700000001",
    "msg\n",
    `\n${lines.join("\n")}\n`,
  ].join("\0");
}

describe("parseAddOrDeleteShas — commits whose --summary block creates or deletes a path", () => {
  it("returns, in log order, every commit with a create or delete mode line", () => {
    const stdout = [
      section(SHA("a"), ["3\t0\tsrc/new.ts", " create mode 100644 src/new.ts"]),
      section(SHA("b"), ["1\t1\tsrc/kept.ts"]),
      section(SHA("c"), ["0\t3\tsrc/gone.ts", " delete mode 100644 src/gone.ts"]),
    ].join("");

    expect(parseAddOrDeleteShas(stdout)).toEqual([SHA("a"), SHA("c")]);
  });

  it("excludes a rename inside the pathspec, a mode change and a merge with no diff block", () => {
    const stdout = [
      section(SHA("a"), ["0\t0\tsrc/{a.ts => b.ts}", " rename src/{a.ts => b.ts} (100%)"]),
      section(SHA("b"), ["0\t0\tbin/run.sh", " mode change 100644 => 100755 bin/run.sh"]),
      section(SHA("c"), [], `${SHA("d")} ${SHA("e")}`),
    ].join("");

    expect(parseAddOrDeleteShas(stdout)).toEqual([]);
  });

  it("keeps a quoted path and a binary add", () => {
    const stdout = [
      section(SHA("a"), ['1\t0\t"sp ace\\320\\277.ts"', ' create mode 100644 "sp ace\\320\\277.ts"']),
      section(SHA("b"), ["-\t-\timg.png", " create mode 100644 img.png"]),
    ].join("");

    expect(parseAddOrDeleteShas(stdout)).toEqual([SHA("a"), SHA("b")]);
  });

  it("does not read a create-mode line inside a commit message", () => {
    const stdout = ["", SHA("a"), "", "A", "a@x", "1", "2", " create mode 100644 x\n", "\n1\t0\tx\n"].join("\0");

    expect(parseAddOrDeleteShas(stdout)).toEqual([]);
  });
});

describe("readCommitFileNumstatForPaths with --summary — real git", () => {
  let repo: string;
  const DAY = 86_400_000;
  const at = (daysAgo: number): string => new Date(Date.now() - daysAgo * DAY).toISOString();
  const who = { name: "T", email: "t@x" };
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

  /** The pre-change three-log read, over raw git. */
  function oracle(paths: string[], since?: Date): CommitFileNumstat[] {
    const window = since ? [`--since=${since.toISOString()}`, "--full-history"] : [];
    const entries = parseCommitFileNumstat(git("log", "HEAD", ...window, "--numstat", FORMAT, "--", ...paths));
    const addOrDelete = git("log", "HEAD", ...window, "--diff-filter=AD", "--format=%H", "--", ...paths)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (addOrDelete.length === 0) return entries;
    const named = new Set(paths);
    const unrestricted = new Map(
      parseCommitFileNumstat(git("log", "--no-walk=unsorted", FORMAT, "--numstat", ...addOrDelete)).map((entry) => [
        entry.commit.sha,
        entry,
      ]),
    );
    return entries.map((entry) => {
      const full = unrestricted.get(entry.commit.sha);
      if (!full) return entry;
      const files = full.files.filter(
        (row) => named.has(row.path) || (row.previousPath !== undefined && named.has(row.previousPath)),
      );
      return files.length > 0 ? { ...entry, files } : entry;
    });
  }

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "numstat-summary-")));
    const body = (n: number): string =>
      Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i * n};`).join("\n");
    importGitHistory(repo, [
      { message: "add old", author: who, authorDate: at(300), writes: { "src/old.ts": body(1) } },
      { message: "add gone", author: who, authorDate: at(250), writes: { "src/gone.ts": body(2) } },
      // Renamed into src/c.ts: outside a pathspec naming c.ts only, this prints as an add.
      { message: "move old", author: who, authorDate: at(200), renames: [["src/old.ts", "src/c.ts"]] },
      { message: "fix: c", author: who, authorDate: at(100), writes: { "src/c.ts": body(3) } },
      { message: "drop gone", author: who, authorDate: at(90), deletes: ["src/gone.ts"] },
      { message: "fix: c again", author: who, authorDate: at(10), writes: { "src/c.ts": body(4) } },
    ]);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("parses a --summary log to the same entries as the log without it", () => {
    const paths = ["src/c.ts", "src/gone.ts"];
    expect(parseCommitFileNumstat(git("log", "HEAD", "--numstat", "--summary", FORMAT, "--", ...paths))).toEqual(
      parseCommitFileNumstat(git("log", "HEAD", "--numstat", FORMAT, "--", ...paths)),
    );
  });

  it.each([
    { label: "an out-of-pathspec rename-in", paths: ["src/c.ts"], since: undefined },
    { label: "a rename-in and a delete", paths: ["src/c.ts", "src/gone.ts"], since: undefined },
    { label: "both sides of a rename", paths: ["src/c.ts", "src/old.ts"], since: undefined },
    { label: "a window", paths: ["src/c.ts", "src/gone.ts"], since: new Date(Date.now() - 220 * DAY) },
    { label: "a window holding no add or delete", paths: ["src/c.ts"], since: new Date(Date.now() - 150 * DAY) },
  ])("answers $label exactly as the three-log read did", async ({ paths, since }) => {
    expect(await readCommitFileNumstatForPaths(repo, paths, 30_000, since)).toEqual(oracle(paths, since));
  });

  it("spends two git spawns, not three, when a queried path was created in history", async () => {
    spawnLog.argv.length = 0;

    await readCommitFileNumstatForPaths(repo, ["src/c.ts", "src/gone.ts"], 30_000);

    const logs = spawnLog.argv.filter((argv) => argv.includes("log"));
    expect(logs).toHaveLength(2);
    expect(logs.some((argv) => argv.some((arg) => arg.startsWith("--diff-filter")))).toBe(false);
    expect(logs[0]).toEqual(expect.arrayContaining(["--numstat", "--summary"]));
    expect(logs[1]).toEqual(expect.arrayContaining(["--no-walk=unsorted"]));
  });

  it("spends one git spawn when no queried path was created or deleted in the window", async () => {
    spawnLog.argv.length = 0;

    await readCommitFileNumstatForPaths(repo, ["src/c.ts"], 30_000, new Date(Date.now() - 150 * DAY));

    expect(spawnLog.argv.filter((argv) => argv.includes("log"))).toHaveLength(1);
  });
});
