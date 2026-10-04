/**
 * bd tea-rags-mcp-z3cnd — a chunk is credited only for rows a commit CHANGED,
 * never for the unified-diff context rows around them.
 *
 * The oracle is `git log -L<start>,<end>:<file>` per HEAD chunk range. It
 * credits a commit to a range when an added/removed row falls inside it, and a
 * pure deletion only when the deleted rows sat strictly INSIDE the range — a
 * deletion at the seam between two chunks credits neither.
 *
 * Fixture (one file, five chunks), each later commit aimed at one case:
 *   - `alpha` edit whose 4-line diff context reaches into `other` (neighbour);
 *   - pure deletion of a comment row inside `gamma`;
 *   - pure deletion of the blank row at the `other` / `gamma` seam;
 *   - edit of `delta`'s last row, exactly adjacent to `eps`'s first row.
 *
 * Production path end to end: real `GitCliAdapter`, real `GitCommitDiscovery`,
 * real `git cat-file --batch`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { importGitHistory, type GitHistoryCommit } from "../../../../__helpers__/git-history-import.js";
import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import { buildChunkChurnMapUncached } from "../../../../../../src/core/domains/trajectory/git/infra/chunk-reader.js";
import { GitCommitDiscovery } from "../../../../../../src/core/domains/trajectory/git/infra/commit-discovery.js";
import type { ChunkChurnOverlay } from "../../../../../../src/core/domains/trajectory/git/types.js";

vi.setConfig({ testTimeout: 30000 });

const TMP_BASE = realpathSync(tmpdir());
const WINDOW_MONTHS = 12;
const FILE = "src/calc.ts";
const CHUNK_NAMES = ["alpha", "other", "gamma", "delta", "eps"] as const;

function at(days: number, hours: number): string {
  return new Date(Date.now() - days * 86400_000 + hours * 3600_000).toISOString();
}

function gitIn(cwd: string, args: string[], isoDate: string): string {
  if (!resolve(cwd).startsWith(TMP_BASE + sep)) {
    throw new Error(`walk-commits-context-rows-real-git.test: refusing git "${args[0]}" in non-temp cwd: ${cwd}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  }).trim();
}

interface Variant {
  alphaC: number;
  gammaNote: boolean;
  seamBlank: boolean;
  deltaTail: number;
}

function source(v: Variant): string {
  return [
    "export function alpha(): number {",
    "  const a = 1;",
    "  const b = 2;",
    `  const c = ${v.alphaC};`,
    "  return a + b + c;",
    "}",
    "export function other(): number {",
    "  return 42;",
    "}",
    ...(v.seamBlank ? [""] : []),
    "export function gamma(): number {",
    "  const x = 1;",
    ...(v.gammaNote ? ["  // note"] : []),
    "  const z = 3;",
    "  return x + z;",
    "}",
    "export function delta(): number {",
    "  return 7;",
    `} // v${v.deltaTail}`,
    "export function eps(): number {",
    "  return 8;",
    "}",
    "",
  ].join("\n");
}

/** 1-based [start, end] of `export function <name>` through its closing brace. */
function rangeOf(content: string, name: string): { startLine: number; endLine: number } {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("}"));
  return { startLine: start + 1, endLine: end + 1 };
}

describe("chunk walk credits only changed rows, like `git log -L` (bd tea-rags-mcp-z3cnd, real git)", () => {
  let repo: string;
  let head: string;

  beforeEach(() => {
    repo = mkdtempSync(join(TMP_BASE, "z3cnd-"));
    // ONE fast-import instead of ~15 add/commit spawns (bd tea-rags-mcp-1r3e5);
    // author and committer are the configured user, as the commit chain made them.
    const test = { name: "Test", email: "t@example.com" };
    const commit = (v: Variant, iso: string, message: string): GitHistoryCommit => {
      head = source(v);
      return { message, author: test, authorDate: iso, writes: { [FILE]: head } };
    };

    const v: Variant = { alphaC: 3, gammaNote: true, seamBlank: true, deltaTail: 1 };
    importGitHistory(
      repo,
      [
        commit(v, at(10, -2), "feat: add calc"),
        commit({ ...v, alphaC: 4 }, at(9, 2), "feat: alpha c=4"),
        commit({ ...v, alphaC: 4, gammaNote: false }, at(8, 2), "chore: drop gamma note"),
        commit({ ...v, alphaC: 4, gammaNote: false, seamBlank: false }, at(7, 2), "style: drop seam blank"),
        commit({ ...v, alphaC: 4, gammaNote: false, seamBlank: false, deltaTail: 2 }, at(6, 2), "fix: delta tail"),
      ],
      { config: { "user.email": "t@example.com", "user.name": "Test", "commit.gpgsign": "false" } },
    );
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const oracle = (name: string): number => {
    const { startLine, endLine } = rangeOf(head, name);
    return gitIn(repo, ["log", "--no-merges", "--format=%H", "-s", `-L${startLine},${endLine}:${FILE}`], at(0, 0))
      .split("\n")
      .filter((l) => /^[0-9a-f]{40}$/.test(l)).length;
  };

  async function walk(): Promise<Map<string, ChunkChurnOverlay>> {
    const adapter = new GitCliAdapter(repo);
    const discovery = new GitCommitDiscovery(adapter, { maxAgeMonths: WINDOW_MONTHS, timeoutMs: 30000 });
    const chunks = CHUNK_NAMES.map((name) => ({ chunkId: name, ...rangeOf(head, name) }));
    const overlays = await buildChunkChurnMapUncached(
      adapter,
      new Map([[join(repo, FILE), chunks]]),
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
    return overlays.get(FILE)!;
  }

  it("the oracle credits each case as designed", () => {
    expect(Object.fromEntries(CHUNK_NAMES.map((n) => [n, oracle(n)]))).toEqual({
      alpha: 2, // creation + its own edit
      other: 1, // creation only: the alpha edit's context and the seam deletion do not count
      gamma: 2, // creation + the pure deletion inside it
      delta: 2, // creation + the edit of its last row
      eps: 1, // creation only: the adjacent edit above its first row does not count
    });
  });

  it("matches `git log -L` commitCount for every chunk", async () => {
    const overlays = await walk();
    const walked = Object.fromEntries(CHUNK_NAMES.map((n) => [n, overlays.get(n)?.commitCount]));
    const expected = Object.fromEntries(CHUNK_NAMES.map((n) => [n, oracle(n)]));
    expect(walked).toEqual(expected);
  });

  it("does not let neighbour context move ageDays, bugFixRate or relativeChurn", async () => {
    const overlays = await walk();
    const other = overlays.get("other")!;
    const eps = overlays.get("eps")!;
    // Only the creating commit (10 days 2 hours ago) touched them.
    expect(other.ageDays).toBe(10);
    expect(eps.ageDays).toBe(10);
    // `fix: delta tail` is a bug fix; it must land on delta only.
    expect(eps.bugFixRate).toBe(0);
    expect(overlays.get("delta")!.bugFixRate).toBe(50);
    // 3 rows added at creation over a 3-row chunk: 3/3 * (1 - e^(-3/30)) = 0.1.
    expect(other.relativeChurn).toBe(0.1);
    expect(eps.relativeChurn).toBe(0.1);
    // gamma: 6 rows added at creation + the 1 row the pure deletion removed,
    // over 5 HEAD rows: 7/5 * (1 - e^(-5/30)) = 0.21.
    expect(overlays.get("gamma")!.relativeChurn).toBe(0.21);
  });
});
