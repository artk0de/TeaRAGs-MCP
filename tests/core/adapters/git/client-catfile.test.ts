/**
 * Real-git tests for the CLI `git cat-file --batch` object reads that replace
 * isomorphic-git in the git adapter. isomorphic-git loaded the entire packfile
 * into a JS ArrayBuffer (profiler: 3×1.4GB on taxdome → OOM); the CLI streams
 * objects from disk. No child_process mock here — these exercise real git.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildViaCli,
  createCatFileBatch,
  readBlobAsString,
  readCommitParent,
} from "../../../../src/core/adapters/git/client.js";

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Every fixture mkdtemp uses this — NOT a fresh tmpdir() call in
// beforeEach — so a transiently-mutated process temp dir (cross-test state in a
// reused worker fork) can't redirect fixtures outside the temp tree.
const TMP_BASE = realpathSync(tmpdir());
// Safety guard: these tests run REAL `git init`/`git commit`. If `cwd` is ever
// falsy or points outside TMP_BASE (broken fixture, mocked mkdtempSync), running
// git there would mutate the real worktree repo. Refuse loudly instead — a
// thrown error fails the test and surfaces the bad cwd, rather than silently
// committing fixture commits onto the project's HEAD.
function gitIn(cwd: string, args: string[]): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`client-catfile.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("readCommitParent (real git)", () => {
  let tmp: string;
  const g = (args: string[]): string => gitIn(tmp, args);

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-cf-"));
    g(["init", "-q"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the first-parent oid of a commit", async () => {
    writeFileSync(join(tmp, "a.txt"), "one");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "A"]);
    const a = g(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(tmp, "a.txt"), "two");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "B"]);
    const b = g(["rev-parse", "HEAD"]).trim();

    expect(await readCommitParent(tmp, b)).toBe(a);
  });

  it("returns null for a root commit (no parent)", async () => {
    writeFileSync(join(tmp, "a.txt"), "one");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "A"]);
    const a = g(["rev-parse", "HEAD"]).trim();

    expect(await readCommitParent(tmp, a)).toBeNull();
  });
});

describe("readBlobAsString (cat-file, real git)", () => {
  let tmp: string;
  const g = (args: string[]): string => gitIn(tmp, args);

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-cf-"));
    g(["init", "-q"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the blob content at a commit (no cache arg)", async () => {
    writeFileSync(join(tmp, "f.ts"), "export const x = 1;\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    expect(await readBlobAsString(tmp, sha, "f.ts")).toBe("export const x = 1;\n");
  });

  it("returns empty string for a path missing at that commit", async () => {
    writeFileSync(join(tmp, "f.ts"), "x");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    expect(await readBlobAsString(tmp, sha, "nope.ts")).toBe("");
  });
});

describe("createCatFileBatch (persistent cat-file --batch, real git)", () => {
  let tmp: string;
  const g = (args: string[]): string => gitIn(tmp, args);

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-cf-"));
    g(["init", "-q"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads several blobs at a commit through ONE reader (reuses the process)", async () => {
    writeFileSync(join(tmp, "a.ts"), "AAA\n");
    writeFileSync(join(tmp, "b.ts"), "BBB\nsecond line\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    const reader = createCatFileBatch(tmp);
    expect(await reader.read(sha, "a.ts")).toBe("AAA\n");
    expect(await reader.read(sha, "b.ts")).toBe("BBB\nsecond line\n");
    await reader.close();
  });

  it("returns empty string for a path missing at that commit", async () => {
    writeFileSync(join(tmp, "f.ts"), "x");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    const reader = createCatFileBatch(tmp);
    expect(await reader.read(sha, "nope.ts")).toBe("");
    await reader.close();
  });

  it("reads the correct per-commit content for the same path", async () => {
    writeFileSync(join(tmp, "a.ts"), "one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "A"]);
    const a = g(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(tmp, "a.ts"), "two\nthree\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "B"]);
    const b = g(["rev-parse", "HEAD"]).trim();

    const reader = createCatFileBatch(tmp);
    expect(await reader.read(a, "a.ts")).toBe("one\n");
    expect(await reader.read(b, "a.ts")).toBe("two\nthree\n");
    await reader.close();
  });

  it("rejects reads after close()", async () => {
    writeFileSync(join(tmp, "a.ts"), "x\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    const reader = createCatFileBatch(tmp);
    expect(await reader.read(sha, "a.ts")).toBe("x\n");
    await reader.close();
    await expect(reader.read(sha, "a.ts")).rejects.toThrow();
  });

  it("reads blobs of differing sizes through one reader without frame bleed", async () => {
    // Multi-frame buffering: a tiny blob, then a large one whose content
    // contains newlines (the frame is length-delimited, not newline-delimited).
    // Reading them back-to-back through ONE process exercises the onData loop
    // splitting several responses out of buffered stdout chunks.
    const big = `${"line of text\n".repeat(500)}tail-no-newline`;
    writeFileSync(join(tmp, "tiny.ts"), "x");
    writeFileSync(join(tmp, "big.ts"), big);
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    const reader = createCatFileBatch(tmp);
    expect(await reader.read(sha, "tiny.ts")).toBe("x");
    expect(await reader.read(sha, "big.ts")).toBe(big);
    // Read the tiny one again after the big one — proves the buffer cursor
    // advanced past the big frame cleanly (no leftover bytes).
    expect(await reader.read(sha, "tiny.ts")).toBe("x");
    await reader.close();
  });

  it("close() is idempotent and tears the process down", async () => {
    writeFileSync(join(tmp, "a.ts"), "x\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
    const sha = g(["rev-parse", "HEAD"]).trim();

    const reader = createCatFileBatch(tmp);
    expect(await reader.read(sha, "a.ts")).toBe("x\n");
    await reader.close();
    // Second close() is a no-op — does not hang, does not throw.
    await expect(reader.close()).resolves.toBeUndefined();
    // The process is gone: reads reject.
    await expect(reader.read(sha, "a.ts")).rejects.toThrow();
  });

  it("a reader that never reads never spawns a process (close is a no-op)", async () => {
    // Lazy spawn: createCatFileBatch must not fork git until the first read().
    // A walk that reads no blobs (all files skipped) must be able to close()
    // cleanly without ever having spawned. We point at a bogus repo path on
    // purpose — if close() tried to touch a child it would observe there is
    // none. No read() is issued, so no process exists.
    const reader = createCatFileBatch(join(tmp, "does-not-matter-never-spawned"));
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.close()).resolves.toBeUndefined();
  });

  it("rejects the pending read and all later reads when the git process fails to spawn", async () => {
    // Spawning `git cat-file --batch` with a non-existent cwd makes Node emit
    // an 'error' (ENOENT) on the child before any data. The reader must reject
    // the in-flight read AND latch the fatal error so every subsequent read
    // rejects too (no silently-hung promises).
    const reader = createCatFileBatch(join(tmp, "no-such-cwd-xyz-12345"));
    await expect(reader.read("deadbeef", "foo")).rejects.toThrow();
    // fatal latched → a fresh read short-circuits with the same failure.
    await expect(reader.read("deadbeef", "foo")).rejects.toThrow();
  });

  it("rejects the pending read when the git process exits unexpectedly", async () => {
    // A directory that is NOT a git repo: `git cat-file --batch` prints a fatal
    // to (ignored) stderr and exits 128 immediately. The reader sees the child
    // 'close' before any response and must reject the pending read rather than
    // hang. No close() here — the process is already gone (close() after an
    // already-exited child would await a 'close' event that never re-fires).
    const nonRepo = mkdtempSync(join(TMP_BASE, "git-nonrepo-"));
    try {
      const reader = createCatFileBatch(nonRepo);
      await expect(reader.read("deadbeef", "foo")).rejects.toThrow(/exited unexpectedly/);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});

describe("buildViaCli (git log --numstat, real git)", () => {
  let tmp: string;
  const g = (args: string[]): string => gitIn(tmp, args);

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-cf-"));
    g(["init", "-q"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("parses per-file churn from the real log --numstat output", async () => {
    writeFileSync(join(tmp, "a.ts"), "one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "A"]);
    writeFileSync(join(tmp, "a.ts"), "one\ntwo\nthree\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "B"]);

    const churn = await buildViaCli(tmp);
    const a = churn.get("a.ts");
    expect(a).toBeDefined();
    // Two commits touched a.ts; the second added two lines.
    expect(a?.commits.length).toBe(2);
    expect(a?.linesAdded).toBeGreaterThanOrEqual(3);
  });

  it("filters commits by sinceDate (future date → empty churn map)", async () => {
    writeFileSync(join(tmp, "a.ts"), "one\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "A"]);

    const future = new Date(Date.now() + 86_400_000);
    const churn = await buildViaCli(tmp, future);
    expect(churn.size).toBe(0);
  });
});
