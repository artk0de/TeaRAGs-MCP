/**
 * bd tea-rags-mcp-z8w16 — live residual, reproduced on a real temp repo.
 *
 * A chunk's history must match `git log -L<start>,<end>:<file>`, which follows
 * renames. Fixture (the live z8fix repo): `computeTotal` (lines 1-8) is added,
 * edited twice, the file is renamed with no content change, then edited once
 * more at the new path. A never-renamed control file gets the same four
 * content commits. The oracle is 4 for both.
 *
 * The lost commit was the one that CREATED the renamed file: it is the repo's
 * root commit, and the walk skipped every root commit as "nothing to diff". A
 * root commit adds every line it holds — exactly what `git log -L` credits it
 * with, and what the walk already credits a non-root commit that adds a file
 * (its parent blob reads as empty). The control file's creation is not a root
 * commit, which is why only the renamed file showed 3.
 *
 * Production path end to end: real `GitCliAdapter`, real `GitCommitDiscovery`
 * matrix (repo-wide `-M` rename detection), real `git cat-file --batch`.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { GitCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import type { ChunkChurnOverlay } from "../../../../../../src/core/domains/trajectory/git/types.js";

vi.setConfig({ testTimeout: 30000 });

const TMP_BASE = realpathSync(tmpdir());
const WINDOW_MONTHS = 12;

/** ISO date `days` days and `hours` hours before now — always inside the window. */
function at(days: number, hours: number): string {
  return new Date(Date.now() - days * 86400_000 + hours * 3600_000).toISOString();
}

function gitIn(cwd: string, args: string[], isoDate: string): string {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) {
    throw new Error(`walk-commits-rename-real-git.test: refusing git "${args[0]}" in non-temp cwd: ${cwd}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  }).trim();
}

/** computeTotal spans lines 1-8; version `v` rewrites lines 4 and 6 only. */
function source(v: number): string {
  return [
    "export function computeTotal(items: number[]): number {",
    "  let total = 0;",
    "  for (const item of items) {",
    `    total += item * ${v};`,
    "  }",
    `  // factor ${v}`,
    "  return total;",
    "}",
    // Padding between the two chunks. The walk credits changed rows only
    // (bd tea-rags-mcp-z3cnd), so `other` would stay untouched without it too.
    ...Array.from({ length: 7 }, () => ""),
    "export function other(): number {",
    "  return 42;",
    "}",
    "",
  ].join("\n");
}

const CHUNKS = (prefix: string) => [
  { chunkId: `${prefix}-computeTotal`, startLine: 1, endLine: 8 },
  { chunkId: `${prefix}-other`, startLine: 16, endLine: 18 },
];

describe("chunk walk follows a rename like `git log -L` (bd tea-rags-mcp-z8w16, real git)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(TMP_BASE, "z8w16-"));
    const g = (args: string[], iso: string): string => gitIn(repo, args, iso);
    const commit = (iso: string, message: string): void => {
      g(["add", "-A"], iso);
      g(["commit", "-q", "-m", message], iso);
    };
    const write = (path: string, v: number): void => {
      writeFileSync(join(repo, path), source(v));
    };

    g(["init", "-q", "-b", "main"], at(10, 0));
    g(["config", "user.email", "t@example.com"], at(10, 0));
    g(["config", "user.name", "Test"], at(10, 0));
    g(["config", "commit.gpgsign", "false"], at(10, 0));
    mkdirSync(join(repo, "src"));

    // Renamed file: 3 content commits at the old path (sessions >= 2h apart).
    write("src/old-name.ts", 1);
    commit(at(10, 8), "feat: add computeTotal");
    write("src/old-name.ts", 2);
    commit(at(10, 11), "fix: factor 2");
    write("src/old-name.ts", 3);
    commit(at(10, 14), "fix: factor 3");
    // Pure rename (R100) — changes no line, so `git log -L` does not list it.
    g(["mv", "src/old-name.ts", "src/new-name.ts"], at(9, 9));
    commit(at(9, 9), "refactor: rename old-name to new-name");
    write("src/new-name.ts", 4);
    commit(at(9, 13), "fix: factor 4");

    // Control: the same 4 content commits, never renamed.
    write("src/control.ts", 1);
    commit(at(8, 8), "feat: add control");
    write("src/control.ts", 2);
    commit(at(8, 11), "fix: control 2");
    write("src/control.ts", 3);
    commit(at(8, 14), "fix: control 3");
    write("src/control.ts", 4);
    commit(at(8, 18), "fix: control 4");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** `git log --no-merges -s -L1,8:<file>` commit count — the oracle. */
  const oracle = (file: string): number =>
    gitIn(repo, ["log", "--no-merges", "--format=%H", "-s", `-L1,8:${file}`], at(0, 0))
      .split("\n")
      .filter((l) => /^[0-9a-f]{40}$/.test(l)).length;

  async function walk(): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    const adapter = new GitCliAdapter(repo);
    const discovery = new GitCommitDiscovery(adapter, { maxAgeMonths: WINDOW_MONTHS, timeoutMs: 30000 });
    const chunkMap = new Map([
      [join(repo, "src/new-name.ts"), CHUNKS("new")],
      [join(repo, "src/control.ts"), CHUNKS("control")],
    ]);
    return await buildChunkChurnMapUncached(
      adapter,
      chunkMap,
      {},
      4,
      WINDOW_MONTHS,
      undefined,
      undefined,
      30000,
      10000,
      undefined,
      undefined,
      undefined,
      undefined,
      discovery,
    );
  }

  it("credits all four content commits to computeTotal in both the renamed and the control file", async () => {
    expect(oracle("src/new-name.ts")).toBe(4);
    expect(oracle("src/control.ts")).toBe(4);

    const overlays = await walk();

    expect(overlays.get("src/control.ts")?.get("control-computeTotal")?.commitCount).toBe(4);
    expect(overlays.get("src/new-name.ts")?.get("new-computeTotal")?.commitCount).toBe(4);
  });

  it("derives the other walk signals identically for the renamed and the control file", async () => {
    const overlays = await walk();
    const renamed = overlays.get("src/new-name.ts")!.get("new-computeTotal")!;
    const control = overlays.get("src/control.ts")!.get("control-computeTotal")!;

    // 1 feat + 3 fix commits on each side.
    expect(renamed.bugFixRate).toBe(75);
    expect(control.bugFixRate).toBe(renamed.bugFixRate);
    expect(renamed.recentContributorCount).toBe(1);
    expect(control.recentContributorCount).toBe(renamed.recentContributorCount);
    // Same four diffs line for line (the add covers all 8 lines, each edit 2).
    expect(renamed.relativeChurn).toBe(control.relativeChurn);
    // Newest touching commit: the post-rename edit (9 days ago) vs control (8).
    expect(renamed.ageDays).toBe(control.ageDays! + 1);
    // `other` (lines 16-18) is touched only by the commit that created it.
    expect(overlays.get("src/new-name.ts")?.get("new-other")?.commitCount).toBe(1);
    expect(overlays.get("src/control.ts")?.get("control-other")?.commitCount).toBe(1);
  });
});
