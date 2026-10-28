/**
 * A codegraph daemon this process may not signal (EPERM — another user, or a
 * sandbox around the client) is still running: waiting for it to exit must not
 * report it gone (bd tea-rags-mcp-hdl65).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDaemonPaths, waitForDaemonExit } from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";

describe("codegraph waitForDaemonExit vs a signal-denied daemon", () => {
  let storageDir: string;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "cg-exit-denied-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(storageDir, { recursive: true, force: true });
  });

  it("keeps waiting while the recorded pid answers signal 0 with EPERM", async () => {
    const paths = getDaemonPaths(storageDir);
    const deniedPid = 424_242;
    mkdirSync(paths.buildDir, { recursive: true });
    writeFileSync(paths.pidFile, String(deniedPid));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    const exited = await waitForDaemonExit(paths, deniedPid, { timeoutMs: 50, pollIntervalMs: 10 });

    expect(exited).toBe(false);
  });
});
