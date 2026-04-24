import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertNoDowngrade,
  getInstalledVersion,
  QDRANT_VERSION,
  warnIfStaleBinary,
} from "../../../../../src/core/adapters/qdrant/embedded/download.js";
import { QdrantDowngradeNotSupportedError } from "../../../../../src/core/adapters/qdrant/errors.js";

describe("assertNoDowngrade", () => {
  const tempDir = join(tmpdir(), `tea-rags-downgrade-${Date.now()}`);
  const binDir = join(tempDir, "qdrant", "bin");
  const versionFile = join(binDir, "qdrant.version");

  beforeEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("is a no-op when no prior install exists (fresh system)", () => {
    expect(() => {
      assertNoDowngrade(tempDir);
    }).not.toThrow();
  });

  it("is a no-op when installed version equals pinned version", () => {
    writeFileSync(versionFile, QDRANT_VERSION, "utf-8");
    expect(() => {
      assertNoDowngrade(tempDir);
    }).not.toThrow();
  });

  it("is a no-op when installed version is older than pinned (legitimate upgrade)", () => {
    writeFileSync(versionFile, "1.10.0", "utf-8");
    expect(() => {
      assertNoDowngrade(tempDir);
    }).not.toThrow();
  });

  it("throws QdrantDowngradeNotSupportedError when installed is newer than pinned", () => {
    writeFileSync(versionFile, "2.5.0", "utf-8");
    expect(() => {
      assertNoDowngrade(tempDir);
    }).toThrow(QdrantDowngradeNotSupportedError);
  });

  it("error carries installed version, pinned version, and binary directory", () => {
    writeFileSync(versionFile, "2.5.0", "utf-8");
    try {
      assertNoDowngrade(tempDir);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(QdrantDowngradeNotSupportedError);
      const msg = (err as Error).message;
      expect(msg).toContain("2.5.0");
      expect(msg).toContain(QDRANT_VERSION);
    }
  });

  it("is a no-op when version file is malformed (treat as unknown, leave to downloader)", () => {
    writeFileSync(versionFile, "not-a-version", "utf-8");
    expect(() => {
      assertNoDowngrade(tempDir);
    }).not.toThrow();
  });
});

describe("warnIfStaleBinary", () => {
  const tempDir = join(tmpdir(), `tea-rags-stale-${Date.now()}`);
  const binDir = join(tempDir, "qdrant", "bin");
  const versionFile = join(binDir, "qdrant.version");

  beforeEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does nothing when no version file exists (fresh install)", () => {
    const logs: string[] = [];
    expect(warnIfStaleBinary(tempDir, (m) => logs.push(m))).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it("does nothing when installed version matches pinned", () => {
    writeFileSync(versionFile, QDRANT_VERSION, "utf-8");
    const logs: string[] = [];
    expect(warnIfStaleBinary(tempDir, (m) => logs.push(m))).toBe(false);
    expect(logs).toHaveLength(0);
  });

  it("emits a stderr warning when installed differs from pinned", () => {
    writeFileSync(versionFile, "1.10.0", "utf-8");
    const logs: string[] = [];
    expect(warnIfStaleBinary(tempDir, (m) => logs.push(m))).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("1.10.0");
    expect(logs[0]).toContain(QDRANT_VERSION);
    expect(logs[0]).toMatch(/stale|upgrade|idle/i);
  });
});

describe("getInstalledVersion", () => {
  const tempDir = join(tmpdir(), `tea-rags-installed-${Date.now()}`);
  const binDir = join(tempDir, "qdrant", "bin");
  const versionFile = join(binDir, "qdrant.version");

  beforeEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when no version file exists", () => {
    expect(getInstalledVersion(tempDir)).toBeNull();
  });

  it("returns the trimmed contents of qdrant.version", () => {
    writeFileSync(versionFile, "1.17.0\n", "utf-8");
    expect(getInstalledVersion(tempDir)).toBe("1.17.0");
  });
});
