import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  EMBEDDED_MARKER,
  getDaemonPaths,
  gracefulKill,
  isDaemonAlive,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon.js";

describe("EMBEDDED_MARKER", () => {
  it("equals 'embedded'", () => {
    expect(EMBEDDED_MARKER).toBe("embedded");
  });
});

describe("getDaemonPaths", () => {
  it("returns pid, port, refs, lock files under storage path", () => {
    const paths = getDaemonPaths("/tmp/test-qdrant");
    expect(paths.pidFile).toBe("/tmp/test-qdrant/daemon.pid");
    expect(paths.portFile).toBe("/tmp/test-qdrant/daemon.port");
    expect(paths.refsFile).toBe("/tmp/test-qdrant/daemon.refs");
    expect(paths.lockFile).toBe("/tmp/test-qdrant/daemon.lock");
    expect(paths.storagePath).toBe("/tmp/test-qdrant");
  });
});

describe("isDaemonAlive", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when no pid file exists", () => {
    const paths = getDaemonPaths(tempDir);
    expect(isDaemonAlive(paths)).toBe(false);
  });

  it("returns false when pid file contains invalid pid", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, "999999999", "utf-8");
    expect(isDaemonAlive(paths)).toBe(false);
  });

  it("returns true for current process pid", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    expect(isDaemonAlive(paths)).toBe(true);
  });
});

describe("gracefulKill", () => {
  it("is exported and callable", () => {
    expect(typeof gracefulKill).toBe("function");
  });
});
