import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  autoUpdateLogPath,
  closeAutoUpdateLog,
  openAutoUpdateLog,
} from "../../../src/bootstrap/auto-update/updater-log.js";

/** Mirrors MAX_LOG_BYTES in updater-log.ts — the ceiling past which a log is rotated. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;

describe("auto-update updater log", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "tea-rags-updater-log-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates the logs directory on first open and appends across separate runs", () => {
    const first = openAutoUpdateLog(dataDir, "tea-rags");
    writeSync(first.fd, "run-1\n");
    closeAutoUpdateLog(first);

    const second = openAutoUpdateLog(dataDir, "tea-rags");
    writeSync(second.fd, "run-2\n");
    closeAutoUpdateLog(second);

    expect(second.path).toBe(first.path);
    expect(readFileSync(first.path, "utf8")).toBe("run-1\nrun-2\n");
  });

  it("gives each project its own log file so parallel watchers never interleave", () => {
    const a = openAutoUpdateLog(dataDir, "tea-rags");
    const b = openAutoUpdateLog(dataDir, "other-project");
    writeSync(a.fd, "a\n");
    writeSync(b.fd, "b\n");
    closeAutoUpdateLog(a);
    closeAutoUpdateLog(b);

    expect(a.path).not.toBe(b.path);
    expect(readFileSync(a.path, "utf8")).toBe("a\n");
    expect(readFileSync(b.path, "utf8")).toBe("b\n");
  });

  it("truncates a log that grew past the rotation ceiling instead of appending forever", () => {
    const seed = openAutoUpdateLog(dataDir, "tea-rags");
    closeAutoUpdateLog(seed);
    writeFileSync(seed.path, Buffer.alloc(MAX_LOG_BYTES + 1, "x"));

    const rotated = openAutoUpdateLog(dataDir, "tea-rags");
    writeSync(rotated.fd, "fresh\n");
    closeAutoUpdateLog(rotated);

    expect(readFileSync(rotated.path, "utf8")).toBe("fresh\n");
  });

  it("keeps history while the log is still under the rotation ceiling", () => {
    const seed = openAutoUpdateLog(dataDir, "tea-rags");
    closeAutoUpdateLog(seed);
    writeFileSync(seed.path, "previous-run\n");

    const reopened = openAutoUpdateLog(dataDir, "tea-rags");
    writeSync(reopened.fd, "next-run\n");
    closeAutoUpdateLog(reopened);

    expect(readFileSync(reopened.path, "utf8")).toBe("previous-run\nnext-run\n");
  });

  it("releases the descriptor on close so writes through it no longer land", () => {
    const handle = openAutoUpdateLog(dataDir, "tea-rags");
    writeSync(handle.fd, "before-close\n");
    closeAutoUpdateLog(handle);

    expect(() => writeSync(handle.fd, "after-close\n")).toThrow();
    expect(readFileSync(handle.path, "utf8")).toBe("before-close\n");
  });

  it("swallows a close of an already-released descriptor (teardown must never throw)", () => {
    expect(() => {
      closeAutoUpdateLog({ fd: -1, path: join(dataDir, "logs", "auto-update-gone.log") });
    }).not.toThrow();
  });

  it("reports the log location without touching the filesystem", () => {
    const predicted = autoUpdateLogPath(dataDir, "tea-rags");
    expect(existsSync(join(dataDir, "logs"))).toBe(false);

    const handle = openAutoUpdateLog(dataDir, "tea-rags");
    closeAutoUpdateLog(handle);

    expect(predicted).toBe(handle.path);
    expect(existsSync(predicted)).toBe(true);
  });
});
