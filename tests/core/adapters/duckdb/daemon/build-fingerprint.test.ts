/**
 * Build-fingerprint determinism tests (bd tea-rags-mcp-ji56r).
 *
 * The fingerprint identifies the RUNNING build so the daemon handshake can
 * detect a stale daemon (spawned from an older `build/`) and restart it from
 * the client's build. Both peers compute it from the same module, so equal
 * build tree => equal fingerprint; different realpath OR different mtime OR
 * different package version => different fingerprint.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  computeBuildFingerprint,
  getBuildFingerprint,
} from "../../../../../src/core/adapters/duckdb/daemon/build-fingerprint.js";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  delete process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT;
});

/** Create `<dir>/pkg/daemon/entry.js` + `<dir>/pkg/package.json` fixture tree. */
function makeBuildTree(version: string): { moduleFile: string; pkgDir: string } {
  dir = mkdtempSync(join(tmpdir(), "cg-fp-"));
  const pkgDir = join(dir, "pkg");
  const daemonDir = join(pkgDir, "daemon");
  mkdirSync(daemonDir, { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "x", version }), "utf-8");
  const moduleFile = join(daemonDir, "entry.js");
  writeFileSync(moduleFile, "// build artifact\n", "utf-8");
  return { moduleFile, pkgDir };
}

describe("computeBuildFingerprint", () => {
  it("is deterministic — same module file yields the identical fingerprint across calls", () => {
    const { moduleFile } = makeBuildTree("1.2.3");
    expect(computeBuildFingerprint(moduleFile)).toBe(computeBuildFingerprint(moduleFile));
  });

  it("embeds the nearest package.json version", () => {
    const { moduleFile } = makeBuildTree("9.9.9");
    expect(computeBuildFingerprint(moduleFile)).toContain("9.9.9");
  });

  it("changes when the module file's mtime changes (in-place rebuild)", () => {
    const { moduleFile } = makeBuildTree("1.2.3");
    const before = computeBuildFingerprint(moduleFile);
    // Simulate `npm run build` rewriting the artifact: bump mtime by 2s.
    const future = new Date(Date.now() + 2_000);
    utimesSync(moduleFile, future, future);
    expect(computeBuildFingerprint(moduleFile)).not.toBe(before);
  });

  it("changes across build directories (npm link re-pointed at another worktree)", () => {
    const treeA = makeBuildTree("1.2.3");
    const fpA = computeBuildFingerprint(treeA.moduleFile);
    const dirA = dir;
    const treeB = makeBuildTree("1.2.3");
    const fpB = computeBuildFingerprint(treeB.moduleFile);
    rmSync(dirA, { recursive: true, force: true });
    expect(fpA).not.toBe(fpB);
  });

  it("defaults to fingerprinting its own module (no arg) and stays stable", () => {
    expect(computeBuildFingerprint()).toBe(computeBuildFingerprint());
  });
});

describe("getBuildFingerprint", () => {
  it("returns the cached self-fingerprint and honours the env override hook", () => {
    const computed = getBuildFingerprint();
    expect(computed).toBe(getBuildFingerprint());
    // Env override (integration-test hook: force a spawned daemon to present a
    // different build identity than the in-process client).
    process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT = "forced-fp";
    expect(getBuildFingerprint()).toBe("forced-fp");
    delete process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT;
    expect(getBuildFingerprint()).toBe(computed);
  });
});
