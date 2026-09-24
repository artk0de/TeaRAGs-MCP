import type { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  adoptGitExecutable,
  createGitExecutableResolver,
  PATH_GIT_EXECUTABLE,
  PLATFORM_GIT_EXECUTABLE,
  probeGitExecutable,
  resolveGitExecutable,
} from "../../../src/core/infra/git-executable.js";

type SpawnSyncResult = ReturnType<typeof spawnSync>;

function spawnSyncReturning(result: Partial<SpawnSyncResult>): typeof spawnSync {
  return vi.fn(() => ({ pid: 1, output: [], stdout: "", stderr: "", status: null, signal: null, ...result })) as never;
}

describe("probeGitExecutable", () => {
  it("accepts a candidate that exits 0 and prints a `git version` banner", () => {
    const impl = spawnSyncReturning({ status: 0, stdout: "git version 2.39.5 (Apple Git-154)\n" });

    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, impl)).toBe(true);
    expect(impl).toHaveBeenCalledWith(
      PLATFORM_GIT_EXECUTABLE,
      ["--version"],
      expect.objectContaining({ timeout: 3000, encoding: "utf8" }),
    );
  });

  it("rejects the xcrun shim that exits non-zero when Command Line Tools are missing", () => {
    const impl = spawnSyncReturning({
      status: 1,
      stdout: "",
      stderr: "xcode-select: note: No developer tools were found, requesting install.\n",
    });

    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, impl)).toBe(false);
  });

  it("rejects a candidate that exits 0 but prints something other than a git banner", () => {
    const impl = spawnSyncReturning({ status: 0, stdout: "xcrun: error: invalid active developer path\n" });

    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, impl)).toBe(false);
  });

  it("rejects a candidate whose probe timed out", () => {
    const timeout = Object.assign(new Error("spawnSync /usr/bin/git ETIMEDOUT"), { code: "ETIMEDOUT" });
    const impl = spawnSyncReturning({ status: null, signal: "SIGTERM", error: timeout });

    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, impl)).toBe(false);
  });

  it("rejects a candidate that does not exist (ENOENT)", () => {
    const enoent = Object.assign(new Error("spawnSync /usr/bin/git ENOENT"), { code: "ENOENT" });
    const impl = spawnSyncReturning({ status: null, error: enoent });

    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, impl)).toBe(false);
  });

  it("rejects when the spawn itself throws or yields no result", () => {
    const throwing = vi.fn(() => {
      throw new Error("boom");
    }) as never;
    const empty = vi.fn(() => undefined) as never;

    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, throwing)).toBe(false);
    expect(probeGitExecutable(PLATFORM_GIT_EXECUTABLE, empty)).toBe(false);
  });
});

describe("createGitExecutableResolver", () => {
  it("resolves Apple's platform git when it probes usable", () => {
    const probe = vi.fn(() => true);

    expect(createGitExecutableResolver(probe)()).toBe("/usr/bin/git");
    expect(probe).toHaveBeenCalledWith("/usr/bin/git");
  });

  it("falls back to `git` from PATH when the platform git is not usable", () => {
    expect(createGitExecutableResolver(() => false)()).toBe("git");
    expect(PATH_GIT_EXECUTABLE).toBe("git");
  });

  it("probes once and memoizes the decision", () => {
    const probe = vi.fn(() => true);
    const resolve = createGitExecutableResolver(probe);

    resolve();
    resolve();
    resolve();

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("memoizes the fallback too — a failed probe is not retried per spawn", () => {
    const probe = vi.fn(() => false);
    const resolve = createGitExecutableResolver(probe);

    expect(resolve()).toBe("git");
    expect(resolve()).toBe("git");
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("adoptGitExecutable", () => {
  it("makes a worker thread use the executable its parent already resolved", () => {
    adoptGitExecutable("/parent/resolved/git");

    expect(resolveGitExecutable()).toBe("/parent/resolved/git");
  });
});
