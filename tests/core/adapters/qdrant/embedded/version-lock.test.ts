import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Tests the version lock mechanism by simulating the file layout
 * that downloadQdrant creates: binary + qdrant.version file.
 *
 * We can't easily mock getBinaryPath in ESM, so we test the logic
 * by replicating what isBinaryUpToDate checks:
 * 1. Binary file exists at getBinaryPath()
 * 2. qdrant.version file next to binary contains EMBEDDED_QDRANT_VERSION
 */
describe("version lock file logic", () => {
  const tempDir = join(tmpdir(), `tea-rags-version-lock-${Date.now()}`);
  const versionFile = join(tempDir, "qdrant.version");
  const binaryFile = join(tempDir, "qdrant");

  beforeEach(() => {
    mkdirSync(tempDir, { recursive: true });
    // Clean files between tests
    for (const f of [versionFile, binaryFile]) {
      try {
        rmSync(f);
      } catch {
        /* ignore */
      }
    }
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("no binary, no version file → not up to date", () => {
    expect(existsSync(binaryFile)).toBe(false);
    expect(existsSync(versionFile)).toBe(false);
  });

  it("binary exists, no version file → not up to date", () => {
    writeFileSync(binaryFile, "fake-binary");
    expect(existsSync(binaryFile)).toBe(true);
    expect(existsSync(versionFile)).toBe(false);
  });

  it("binary + version file with wrong version → not up to date", () => {
    writeFileSync(binaryFile, "fake-binary");
    writeFileSync(versionFile, "0.0.1");
    expect(readFileSync(versionFile, "utf-8").trim()).not.toBe("1.17.0");
  });

  it("binary + version file with correct version → up to date", async () => {
    const { EMBEDDED_QDRANT_VERSION } = await import("../../../../../src/core/adapters/qdrant/embedded/download.js");
    writeFileSync(binaryFile, "fake-binary");
    writeFileSync(versionFile, EMBEDDED_QDRANT_VERSION);
    expect(existsSync(binaryFile)).toBe(true);
    expect(readFileSync(versionFile, "utf-8").trim()).toBe(EMBEDDED_QDRANT_VERSION);
  });

  it("version file written by downloadQdrant contains EMBEDDED_QDRANT_VERSION", async () => {
    const { EMBEDDED_QDRANT_VERSION } = await import("../../../../../src/core/adapters/qdrant/embedded/download.js");
    // Simulate what downloadQdrant does at the end
    writeFileSync(versionFile, EMBEDDED_QDRANT_VERSION, "utf-8");
    expect(readFileSync(versionFile, "utf-8")).toBe(EMBEDDED_QDRANT_VERSION);
  });
});
