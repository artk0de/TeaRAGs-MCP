import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  invalidateRecoveryCache,
  isRecoveryComplete,
  markRecoveryComplete,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery-cache.js";

describe("RecoveryStateCache", () => {
  let tempDir: string;
  const collection = "test_collection";

  beforeEach(() => {
    tempDir = join(tmpdir(), `recovery-cache-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when no marker file exists", () => {
    expect(isRecoveryComplete(tempDir, collection)).toBe(false);
  });

  it("returns true after markRecoveryComplete", () => {
    markRecoveryComplete(tempDir, collection);
    expect(isRecoveryComplete(tempDir, collection)).toBe(true);
  });

  it("returns false after invalidateRecoveryCache", () => {
    markRecoveryComplete(tempDir, collection);
    expect(isRecoveryComplete(tempDir, collection)).toBe(true);

    invalidateRecoveryCache(tempDir, collection);
    expect(isRecoveryComplete(tempDir, collection)).toBe(false);
  });

  it("invalidate is safe when marker does not exist", () => {
    expect(() => {
      invalidateRecoveryCache(tempDir, collection);
    }).not.toThrow();
  });

  it("creates snapshot directory if missing", () => {
    const nestedDir = join(tempDir, "nested", "dir");
    markRecoveryComplete(nestedDir, collection);
    expect(isRecoveryComplete(nestedDir, collection)).toBe(true);
  });

  it("writes timestamp to marker file", () => {
    markRecoveryComplete(tempDir, collection);
    const markerFile = join(tempDir, `${collection}.recovery-complete`);
    expect(existsSync(markerFile)).toBe(true);
  });

  it("handles different collections independently", () => {
    markRecoveryComplete(tempDir, "col_a");
    expect(isRecoveryComplete(tempDir, "col_a")).toBe(true);
    expect(isRecoveryComplete(tempDir, "col_b")).toBe(false);
  });
});
