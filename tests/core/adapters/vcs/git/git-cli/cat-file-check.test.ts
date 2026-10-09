/**
 * bd tea-rags-mcp-v2mlw — real-git tests for the persistent
 * `git cat-file --batch-check` OID resolver. ONE long-lived process resolves
 * `HEAD:<path>` revs to blob OIDs (metadata only, no content transfer) — the
 * blame cache keys on these OIDs, and the persistent process is immune to
 * the machine-wide EDR fresh-spawn cap that throttles per-file git spawns.
 * No child_process mock (precedent: client-catfile.test.ts).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCatFileBatchCheck } from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";

// Temp base captured ONCE at module load (realpath-normalised; macOS /var →
// /private/var). Guard: these tests run REAL `git init`/`git commit` — refuse
// loudly if cwd ever points outside the temp tree (see client-catfile.test.ts).
const TMP_BASE = realpathSync(tmpdir());
function gitIn(cwd: string, args: string[]): string {
  const r = cwd ? resolve(cwd) : "";
  if (!r?.startsWith(TMP_BASE + sep)) {
    throw new Error(`client-catfile-check.test: refusing git "${args[0]}" in non-temp cwd: ${String(cwd)}`);
  }
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("createCatFileBatchCheck (persistent cat-file --batch-check, real git)", () => {
  let tmp: string;
  const g = (args: string[]): string => gitIn(tmp, args);

  beforeEach(() => {
    tmp = mkdtempSync(join(TMP_BASE, "git-cfc-"));
    g(["init", "-q"]);
    g(["config", "user.email", "t@example.com"]);
    g(["config", "user.name", "Test"]);
    writeFileSync(join(tmp, "a.ts"), "AAA\n");
    writeFileSync(join(tmp, "b.ts"), "BBB\nsecond line\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "c"]);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resolves HEAD:<path> to the blob OID (matches git rev-parse)", async () => {
    const expected = g(["rev-parse", "HEAD:a.ts"]).trim();
    const reader = createCatFileBatchCheck(tmp);
    try {
      expect(await reader.check("HEAD:a.ts")).toBe(expected);
    } finally {
      await reader.close();
    }
  });

  it("resolves a missing rev to null", async () => {
    const reader = createCatFileBatchCheck(tmp);
    try {
      expect(await reader.check("HEAD:does-not-exist.ts")).toBeNull();
    } finally {
      await reader.close();
    }
  });

  it("keeps FIFO order across concurrent checks (existing + missing interleaved)", async () => {
    const oidA = g(["rev-parse", "HEAD:a.ts"]).trim();
    const oidB = g(["rev-parse", "HEAD:b.ts"]).trim();
    const reader = createCatFileBatchCheck(tmp);
    try {
      // Dispatch all four in the same tick — responses are line-based FIFO;
      // a frame swap would misattribute an OID to a missing rev or vice versa.
      const [r1, r2, r3, r4] = await Promise.all([
        reader.check("HEAD:a.ts"),
        reader.check("HEAD:missing-one.ts"),
        reader.check("HEAD:b.ts"),
        reader.check("HEAD:missing-two.ts"),
      ]);
      expect(r1).toBe(oidA);
      expect(r2).toBeNull();
      expect(r3).toBe(oidB);
      expect(r4).toBeNull();
    } finally {
      await reader.close();
    }
  });

  it("rejects checks after close()", async () => {
    const reader = createCatFileBatchCheck(tmp);
    expect(await reader.check("HEAD:a.ts")).not.toBeNull();
    await reader.close();
    await expect(reader.check("HEAD:a.ts")).rejects.toThrow();
  });

  it("close() is idempotent (walked and never-walked readers)", async () => {
    // Never-checked reader: close() without a spawned process is a no-op.
    const idle = createCatFileBatchCheck(tmp);
    await expect(idle.close()).resolves.toBeUndefined();
    await expect(idle.close()).resolves.toBeUndefined();

    // Checked reader: close() tears the process down; the second close no-ops.
    const reader = createCatFileBatchCheck(tmp);
    expect(await reader.check("HEAD:a.ts")).not.toBeNull();
    await expect(reader.close()).resolves.toBeUndefined();
    await expect(reader.close()).resolves.toBeUndefined();
  });
});
