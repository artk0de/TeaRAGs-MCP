/**
 * Real-git tests for `readCommitFileNumstat` — the numstat-PRESERVING log
 * reader. Existing `getCommitsSince`/`getCommitsInRange` parse the same
 * `git log --numstat` output via `parsePathspecOutput` but throw the +/-
 * counts away (keep only `changedFiles: string[]`); this reader keeps them
 * per-commit per-file, the substrate for a commit-cache evict/re-aggregate.
 * No child_process mock — exercises real git against a tiny temp repo,
 * mirroring the real-git harness in `git-cli/client-catfile.test.ts`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitCliAdapter } from "../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Guards against running real `git init`/`git commit` outside
// the temp tree (see client-catfile.test.ts for the same pattern).
const TMP_BASE = realpathSync(tmpdir());

function gitIn(cwd: string, args: string[], isoDate: string): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`commit-file-numstat.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
  }).trim();
}

describe("readCommitFileNumstat (real git)", () => {
  let tmp: string;
  let adapter: GitCliAdapter;
  let c1sha: string;
  let c2sha: string;

  const sinceEpoch = new Date("2023-01-01T00:00:00Z"); // before every fixture commit
  const T1 = "2024-01-01T00:00:00Z";
  const T2 = "2024-01-02T00:00:00Z";

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-numstat-"));
    const g = (args: string[], isoDate: string): string => gitIn(tmp, args, isoDate);

    g(["init", "-q", "-b", "main"], T1);
    g(["config", "user.email", "t@example.com"], T1);
    g(["config", "user.name", "Test"], T1);
    g(["config", "commit.gpgsign", "false"], T1);
    g(["config", "diff.algorithm", "myers"], T1);

    // c1 — creates a.ts (3 lines): pure add, +3/-0.
    writeFileSync(join(tmp, "a.ts"), "x\ny\nz\n");
    g(["add", "-A"], T1);
    g(["commit", "-q", "-m", "c1: add a.ts"], T1);
    c1sha = g(["rev-parse", "HEAD"], T1);

    // c2 — replaces the middle line of a.ts with 3 lines (+3/-1) and adds a
    // binary file (NUL bytes trigger git's binary heuristic, same fixture
    // byte pattern already pinned in equivalence-repo.ts).
    writeFileSync(join(tmp, "a.ts"), "x\ny1\ny2\ny3\nz\n");
    writeFileSync(join(tmp, "img.png"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x42]));
    g(["add", "-A"], T2);
    g(["commit", "-q", "-m", "c2: edit a.ts + add binary img.png"], T2);
    c2sha = g(["rev-parse", "HEAD"], T2);

    adapter = new GitCliAdapter(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns per-commit per-file numstat over a since window (newest→oldest)", async () => {
    const entries = await adapter.readCommitFileNumstat(sinceEpoch);

    expect(entries.map((e) => e.commit.sha)).toEqual([c2sha, c1sha]);

    const c2 = entries.find((e) => e.commit.sha === c2sha)!;
    expect(c2.files).toContainEqual({ path: "a.ts", added: 3, deleted: 1 });

    const c1 = entries.find((e) => e.commit.sha === c1sha)!;
    expect(c1.files).toContainEqual({ path: "a.ts", added: 3, deleted: 0 });
  });

  it("populates committerTimestamp (%ct) alongside the author timestamp (%at)", async () => {
    const entries = await adapter.readCommitFileNumstat(sinceEpoch);

    // The fixture pins GIT_AUTHOR_DATE == GIT_COMMITTER_DATE, so %ct == %at ==
    // the commit's epoch. The field must be a populated number (the windowing /
    // eviction / sort key), never undefined or NaN.
    const c2 = entries.find((e) => e.commit.sha === c2sha)!;
    expect(c2.committerTimestamp).toBe(Math.floor(new Date(T2).getTime() / 1000));
    expect(c2.committerTimestamp).toBe(c2.commit.timestamp);

    const c1 = entries.find((e) => e.commit.sha === c1sha)!;
    expect(c1.committerTimestamp).toBe(Math.floor(new Date(T1).getTime() / 1000));
    expect(c1.committerTimestamp).toBe(c1.commit.timestamp);
  });

  it("range form returns only commits in from..to (excludes the 'from' commit)", async () => {
    const entries = await adapter.readCommitFileNumstat(sinceEpoch, { fromSha: c1sha, toSha: c2sha });

    expect(entries.map((e) => e.commit.sha)).toEqual([c2sha]);
  });

  it("skips binary-file rows (matches legacy parseNumstatOutput churn map)", async () => {
    const entries = await adapter.readCommitFileNumstat(sinceEpoch);

    // `-\t-` numstat rows are dropped: a binary-only file must not appear (else
    // it would get a phantom commit vs the legacy full-recompute path). c2 still
    // survives because it also touched the text file a.ts.
    const bin = entries.flatMap((e) => e.files).find((f) => f.path === "img.png");
    expect(bin).toBeUndefined();
  });
});
