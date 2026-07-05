/**
 * File-phase single-discovery (bd tea-rags-mcp-j4lm9).
 *
 * Correctness pin: per-file FileChurnData sliced from the ONE run-scoped
 * repo-wide numstat discovery must DEEP-EQUAL the legacy per-batch
 * `git log HEAD --numstat -- <paths>` path (buildFileSignalsForPaths) on a
 * real multi-commit fixture repo — all fields: commits list (sha, author,
 * email, timestamp, body, parents — the bugfix-classification inputs), churn
 * counts, and Map/commit ordering.
 *
 * Spawn pin: a streaming run of N file batches used to spawn N full-history
 * numstat logs; with the discovery it spawns exactly ONE. Counted through a
 * real PATH shim wrapping the git binary — no child_process mocks here.
 *
 * Real-git fixture pattern follows tests/core/adapters/vcs/git/git-cli/client-catfile.test.ts
 * (gitIn temp-dir guard; the worktree-head-guard globalSetup is the backstop).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GitCliAdapter } from "../../../../../../src/core/adapters/vcs/git/git-cli/adapter.js";
import type { FileChurnData } from "../../../../../../src/core/adapters/vcs/types.js";
import {
  buildFileSignalDiscovery,
  buildFileSignalsForPaths,
  sliceFileSignalsByPaths,
} from "../../../../../../src/core/domains/trajectory/git/infra/file-reader.js";
import { GitEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/git/provider.js";

const TMP_BASE = realpathSync(tmpdir());

/** Refuse to run git outside the temp tree — see client-catfile.test.ts. */
function gitIn(cwd: string, args: string[], env?: Record<string, string>): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`file-discovery.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

/** Author + deterministic timestamps per commit so ordering is stable. */
function commitEnv(name: string, email: string, isoDate: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: isoDate,
  };
}

/**
 * Multi-commit fixture: linear history + a fix/ branch merged with --no-ff
 * (exercises parents/body — the merge-branch bugfix-classification inputs)
 * + a multi-file commit (one CommitInfo shared across two numstat rows).
 */
function buildFixtureRepo(tmp: string): void {
  gitIn(tmp, ["init", "-q", "-b", "main"]);
  gitIn(tmp, ["config", "user.email", "t@example.com"]);
  gitIn(tmp, ["config", "user.name", "Test"]);

  writeFileSync(join(tmp, "a.ts"), "const a = 1;\nconst aa = 2;\nconst aaa = 3;\n");
  writeFileSync(join(tmp, "b.ts"), "const b = 1;\nconst bb = 2;\n");
  gitIn(tmp, ["add", "-A"]);
  gitIn(tmp, ["commit", "-q", "-m", "feat: init a and b"], commitEnv("Alice", "alice@x", "2026-01-01T00:00:00Z"));

  writeFileSync(join(tmp, "b.ts"), "const b = 10;\nconst bb = 2;\nconst bbb = 3;\n");
  gitIn(tmp, ["add", "-A"]);
  gitIn(tmp, ["commit", "-q", "-m", "improve: b tweak"], commitEnv("Bob", "bob@x", "2026-01-01T01:00:00Z"));

  gitIn(tmp, ["checkout", "-q", "-b", "fix/bug-1"]);
  writeFileSync(join(tmp, "a.ts"), "const a = 42;\nconst aa = 2;\nconst aaa = 3;\n");
  gitIn(tmp, ["add", "-A"]);
  gitIn(tmp, ["commit", "-q", "-m", "fix: bug in a"], commitEnv("Carol", "carol@x", "2026-01-01T02:00:00Z"));
  writeFileSync(join(tmp, "c.md"), "# notes\n\nline\nline\n");
  gitIn(tmp, ["add", "-A"]);
  gitIn(tmp, ["commit", "-q", "-m", "docs: notes"], commitEnv("Carol", "carol@x", "2026-01-01T03:00:00Z"));

  gitIn(tmp, ["checkout", "-q", "main"]);
  writeFileSync(join(tmp, "d.ts"), "export const d = 1;\n");
  gitIn(tmp, ["add", "-A"]);
  gitIn(tmp, ["commit", "-q", "-m", "feat: d"], commitEnv("Alice", "alice@x", "2026-01-01T04:00:00Z"));

  gitIn(
    tmp,
    ["merge", "--no-ff", "-q", "fix/bug-1", "-m", "Merge branch 'fix/bug-1'"],
    commitEnv("Alice", "alice@x", "2026-01-01T05:00:00Z"),
  );

  writeFileSync(join(tmp, "a.ts"), "const a = 42;\nconst aa = 20;\nconst aaa = 3;\n");
  writeFileSync(join(tmp, "d.ts"), "export const d = 100;\n");
  gitIn(tmp, ["add", "-A"]);
  gitIn(tmp, ["commit", "-q", "-m", "improve: sweep a and d"], commitEnv("Bob", "bob@x", "2026-01-01T06:00:00Z"));
}

/** The batch shapes a streaming run would produce (incl. a never-committed path). */
const BATCHES: string[][] = [["a.ts", "b.ts"], ["c.md", "missing.ts"], ["d.ts"]];

// ─── sliceFileSignalsByPaths (pure) ──────────────────────────────────────────

describe("sliceFileSignalsByPaths", () => {
  const entry = (linesAdded: number): FileChurnData => ({ commits: [], linesAdded, linesDeleted: 0 });

  it("returns only the requested paths, preserving the discovery's objects by reference", () => {
    const a = entry(1);
    const b = entry(2);
    const discovery = new Map([
      ["a.ts", a],
      ["b.ts", b],
    ]);

    const sliced = sliceFileSignalsByPaths(discovery, ["b.ts"]);

    expect(sliced.size).toBe(1);
    expect(sliced.get("b.ts")).toBe(b);
  });

  it("omits paths absent from the discovery (matches a pathspec log returning no rows)", () => {
    const discovery = new Map([["a.ts", entry(1)]]);
    const sliced = sliceFileSignalsByPaths(discovery, ["a.ts", "missing.ts"]);
    expect([...sliced.keys()]).toEqual(["a.ts"]);
  });

  it("returns an empty map for an empty path list", () => {
    const discovery = new Map([["a.ts", entry(1)]]);
    expect(sliceFileSignalsByPaths(discovery, []).size).toBe(0);
  });
});

// ─── Equivalence pin (real git fixture) ──────────────────────────────────────

describe("file-phase single-discovery equivalence (real git)", () => {
  let tmp: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-fd-"));
    buildFixtureRepo(tmp);
  }, 30000); // ~16 git spawns; 10s default hook timeout is too tight under CI contention (matches blame-cache/churn-walk fixtures)
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("sliced discovery DEEP-EQUALS the legacy per-batch pathspec log for every batch", async () => {
    const discovery = await buildFileSignalDiscovery(new GitCliAdapter(tmp));

    // Guard against a trivially-empty false-green: the fixture history must
    // actually be present in the discovery with the expected commit counts.
    expect(discovery.get("a.ts")?.commits).toHaveLength(3); // init, fix, sweep
    expect(discovery.get("b.ts")?.commits).toHaveLength(2); // init, tweak
    expect(discovery.get("c.md")?.commits).toHaveLength(1); // docs
    expect(discovery.get("d.ts")?.commits).toHaveLength(2); // feat, sweep

    for (const batch of BATCHES) {
      const legacy = await buildFileSignalsForPaths(new GitCliAdapter(tmp), batch);
      const sliced = sliceFileSignalsByPaths(discovery, batch);
      // Deep equality over EVERY FileChurnData field: commits (sha, author,
      // authorEmail, timestamp, body, parents), linesAdded, linesDeleted —
      // and Map iteration / commit ordering.
      expect(sliced).toEqual(legacy);
    }
  });

  it("commit metadata carried by the discovery covers bugfix-classification inputs", async () => {
    const discovery = await buildFileSignalDiscovery(new GitCliAdapter(tmp));
    const aFix = discovery.get("a.ts")?.commits.find((c) => c.body.startsWith("fix: bug in a"));
    expect(aFix).toBeDefined();
    expect(aFix?.author).toBe("Carol");
    expect(aFix?.authorEmail).toBe("carol@x");
    expect(aFix?.parents).toHaveLength(1);
    expect(aFix?.timestamp).toBe(Date.parse("2026-01-01T02:00:00Z") / 1000);
  });

  it("provider streamFileBatch (sliced route) matches the legacy per-batch result per batch", async () => {
    const provider = new GitEnrichmentProvider();
    for (const batch of BATCHES) {
      const legacy = await buildFileSignalsForPaths(new GitCliAdapter(tmp), batch);
      const viaProvider = await provider.streamFileBatch(tmp, batch);
      expect(viaProvider).toEqual(legacy);
    }
  });
});

// ─── Spawn-count pin (PATH shim over real git) ───────────────────────────────

describe("file-phase single-discovery spawn counts (PATH shim)", () => {
  let tmp: string;
  let shimDir: string;
  let spawnLog: string;
  let originalPath: string | undefined;

  const loggedSpawns = (): string[] => {
    try {
      return readFileSync(spawnLog, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    } catch {
      return [];
    }
  };
  const countPrefix = (prefix: string): number => loggedSpawns().filter((l) => l.startsWith(prefix)).length;
  const resetLog = (): void => {
    writeFileSync(spawnLog, "");
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-fd-spawn-"));
    buildFixtureRepo(tmp); // built BEFORE the shim goes on PATH — setup spawns are not counted

    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    shimDir = mkdtempSync(join(TMP_BASE, "git-shim-"));
    spawnLog = join(shimDir, "spawns.log");
    writeFileSync(spawnLog, "");
    const shim = `#!/bin/sh\nprintf '%s\\n' "$*" >> "${spawnLog}"\nexec "${realGit}" "$@"\n`;
    mkdirSync(join(shimDir, "bin"));
    writeFileSync(join(shimDir, "bin", "git"), shim);
    chmodSync(join(shimDir, "bin", "git"), 0o755);

    originalPath = process.env.PATH;
    process.env.PATH = `${join(shimDir, "bin")}:${originalPath ?? ""}`;
  }, 30000); // ~16 git spawns + shim setup; 10s default hook timeout is too tight under CI contention
  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(tmp, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  });

  it("legacy path spawns one full-history numstat log PER BATCH", async () => {
    resetLog();
    for (const batch of BATCHES) {
      await buildFileSignalsForPaths(new GitCliAdapter(tmp), batch);
    }
    expect(countPrefix("log HEAD --numstat")).toBe(BATCHES.length);
  });

  it("discovery path spawns exactly ONE numstat log for the whole run", async () => {
    resetLog();
    const provider = new GitEnrichmentProvider();
    for (const batch of BATCHES) {
      await provider.streamFileBatch(tmp, batch);
    }
    // ONE repo-wide discovery replaces the per-batch full-history walks.
    expect(countPrefix("log HEAD --numstat")).toBe(1);
    // Blame stays per-file, untouched by the discovery: a.ts, b.ts, c.md, d.ts.
    expect(countPrefix("blame")).toBe(4);
  });

  it("CONCURRENT batches (streaming fire-and-forget) still spawn exactly ONE numstat log — single-flight", async () => {
    // The real coordinator calls FilePhase.onBatch per embedding batch WITHOUT
    // awaiting (fire-and-forget), so N streamFileBatch land in flight before the
    // first repo-wide discovery resolves. If getRunDiscovery memoizes the RESULT
    // (not the in-flight PROMISE), every racing batch sees fileDiscovery=null and
    // spawns its OWN full-history `git log --numstat` (~1GB each on a monolith)
    // → the 3-5GB OOM storm. Promise-memoized discovery must collapse them to one.
    resetLog();
    const provider = new GitEnrichmentProvider();
    await Promise.all(BATCHES.map(async (batch) => provider.streamFileBatch(tmp, batch)));
    expect(countPrefix("log HEAD --numstat")).toBe(1);
  });
});
