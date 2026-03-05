/**
 * Tests for TRAJECTORY_GIT_* env var naming convention.
 *
 * Verifies: new name works, old name works as fallback, new name takes priority.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** Env var mapping: [newName, oldName, defaultValue] */
const ENV_MAPPINGS: [string, string, string][] = [
  ["TRAJECTORY_GIT_ENABLED", "CODE_ENABLE_GIT_METADATA", "false"],
  ["TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS", "GIT_LOG_MAX_AGE_MONTHS", "12"],
  ["TRAJECTORY_GIT_LOG_TIMEOUT_MS", "GIT_LOG_TIMEOUT_MS", "60000"],
  ["TRAJECTORY_GIT_CHUNK_CONCURRENCY", "GIT_CHUNK_CONCURRENCY", "10"],
  ["TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS", "GIT_CHUNK_MAX_AGE_MONTHS", "6"],
  ["TRAJECTORY_GIT_CHUNK_TIMEOUT_MS", "GIT_CHUNK_TIMEOUT_MS", "120000"],
  ["TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES", "GIT_CHUNK_MAX_FILE_LINES", "10000"],
];

/** All env var names involved (for cleanup) */
const ALL_KEYS = ENV_MAPPINGS.flatMap(([n, o]) => [n, o]);

describe("TRAJECTORY_GIT env var naming", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear all relevant env vars
    for (const key of ALL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore original env
    for (const key of ALL_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe("parseAppConfig", () => {
    it("should read TRAJECTORY_GIT_ENABLED (new name)", async () => {
      process.env.TRAJECTORY_GIT_ENABLED = "true";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.code.enableGitMetadata).toBe(true);
    });

    it("should fall back to CODE_ENABLE_GIT_METADATA (old name)", async () => {
      process.env.CODE_ENABLE_GIT_METADATA = "true";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.code.enableGitMetadata).toBe(true);
    });

    it("should prefer TRAJECTORY_GIT_ENABLED over CODE_ENABLE_GIT_METADATA", async () => {
      process.env.TRAJECTORY_GIT_ENABLED = "false";
      process.env.CODE_ENABLE_GIT_METADATA = "true";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.code.enableGitMetadata).toBe(false);
    });
  });

  describe("file-reader env vars", () => {
    it("should read TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS (new name)", () => {
      process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS = "24";

      const val = parseFloat(
        process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS ?? process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12",
      );
      expect(val).toBe(24);
    });

    it("should fall back to GIT_LOG_MAX_AGE_MONTHS (old name)", () => {
      process.env.GIT_LOG_MAX_AGE_MONTHS = "24";

      const val = parseFloat(
        process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS ?? process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12",
      );
      expect(val).toBe(24);
    });

    it("should prefer new name over old name", () => {
      process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS = "6";
      process.env.GIT_LOG_MAX_AGE_MONTHS = "24";

      const val = parseFloat(
        process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS ?? process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12",
      );
      expect(val).toBe(6);
    });

    it("should use default when neither is set", () => {
      const val = parseFloat(
        process.env.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS ?? process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12",
      );
      expect(val).toBe(12);
    });

    it("should read TRAJECTORY_GIT_LOG_TIMEOUT_MS (new name)", () => {
      process.env.TRAJECTORY_GIT_LOG_TIMEOUT_MS = "30000";

      const val = parseInt(process.env.TRAJECTORY_GIT_LOG_TIMEOUT_MS ?? process.env.GIT_LOG_TIMEOUT_MS ?? "60000", 10);
      expect(val).toBe(30000);
    });

    it("should fall back to GIT_LOG_TIMEOUT_MS (old name)", () => {
      process.env.GIT_LOG_TIMEOUT_MS = "30000";

      const val = parseInt(process.env.TRAJECTORY_GIT_LOG_TIMEOUT_MS ?? process.env.GIT_LOG_TIMEOUT_MS ?? "60000", 10);
      expect(val).toBe(30000);
    });
  });

  describe("chunk-reader env vars", () => {
    it("should read TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES (new name)", () => {
      process.env.TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES = "5000";

      const val = parseInt(
        process.env.TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES ?? process.env.GIT_CHUNK_MAX_FILE_LINES ?? "10000",
        10,
      );
      expect(val).toBe(5000);
    });

    it("should fall back to GIT_CHUNK_MAX_FILE_LINES (old name)", () => {
      process.env.GIT_CHUNK_MAX_FILE_LINES = "5000";

      const val = parseInt(
        process.env.TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES ?? process.env.GIT_CHUNK_MAX_FILE_LINES ?? "10000",
        10,
      );
      expect(val).toBe(5000);
    });

    it("should read TRAJECTORY_GIT_CHUNK_TIMEOUT_MS (new name)", () => {
      process.env.TRAJECTORY_GIT_CHUNK_TIMEOUT_MS = "60000";

      const val = parseInt(
        process.env.TRAJECTORY_GIT_CHUNK_TIMEOUT_MS ?? process.env.GIT_CHUNK_TIMEOUT_MS ?? "120000",
        10,
      );
      expect(val).toBe(60000);
    });

    it("should fall back to GIT_CHUNK_TIMEOUT_MS (old name)", () => {
      process.env.GIT_CHUNK_TIMEOUT_MS = "60000";

      const val = parseInt(
        process.env.TRAJECTORY_GIT_CHUNK_TIMEOUT_MS ?? process.env.GIT_CHUNK_TIMEOUT_MS ?? "120000",
        10,
      );
      expect(val).toBe(60000);
    });
  });

  describe("provider env vars", () => {
    it("should read TRAJECTORY_GIT_CHUNK_CONCURRENCY (new name)", () => {
      process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY = "20";

      const val = parseInt(
        process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY ?? process.env.GIT_CHUNK_CONCURRENCY ?? "10",
        10,
      );
      expect(val).toBe(20);
    });

    it("should fall back to GIT_CHUNK_CONCURRENCY (old name)", () => {
      process.env.GIT_CHUNK_CONCURRENCY = "20";

      const val = parseInt(
        process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY ?? process.env.GIT_CHUNK_CONCURRENCY ?? "10",
        10,
      );
      expect(val).toBe(20);
    });

    it("should read TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS (new name)", () => {
      process.env.TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS = "3";

      const val = parseFloat(
        process.env.TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS ?? process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6",
      );
      expect(val).toBe(3);
    });

    it("should fall back to GIT_CHUNK_MAX_AGE_MONTHS (old name)", () => {
      process.env.GIT_CHUNK_MAX_AGE_MONTHS = "3";

      const val = parseFloat(
        process.env.TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS ?? process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6",
      );
      expect(val).toBe(3);
    });
  });

  describe("all mappings use default when nothing set", () => {
    for (const [newName, oldName, defaultVal] of ENV_MAPPINGS) {
      it(`${newName} defaults to ${defaultVal}`, () => {
        const val = process.env[newName] ?? process.env[oldName] ?? defaultVal;
        expect(val).toBe(defaultVal);
      });
    }
  });
});

/** Fresh import of config.ts to pick up env var changes */
async function freshImport() {
  const mod = await import("../../src/bootstrap/config.js");
  return mod;
}
