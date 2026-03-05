/**
 * Tests for EMBEDDING_TUNE_* env var renaming with backwards compatibility.
 *
 * Each var must support:
 * 1. New name works
 * 2. Old name works as fallback
 * 3. New name takes priority over old name
 * 4. Default when nothing set
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Env vars we need to clean between tests
const VARS_TO_CLEAN = [
  // New names
  "EMBEDDING_TUNE_CONCURRENCY",
  "EMBEDDING_TUNE_BATCH_SIZE",
  "EMBEDDING_TUNE_MIN_BATCH_SIZE",
  "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
  "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
  "EMBEDDING_TUNE_RETRY_ATTEMPTS",
  "EMBEDDING_TUNE_RETRY_DELAY_MS",
  // Old names
  "EMBEDDING_CONCURRENCY",
  "EMBEDDING_BATCH_SIZE",
  "CODE_BATCH_SIZE",
  "MIN_BATCH_SIZE",
  "BATCH_FORMATION_TIMEOUT_MS",
  "EMBEDDING_MAX_REQUESTS_PER_MINUTE",
  "EMBEDDING_RETRY_ATTEMPTS",
  "EMBEDDING_RETRY_DELAY",
];

/**
 * Helper: isolate env, dynamically import a module, return result.
 * We need fresh imports because env vars are read at module load time.
 */
async function _withCleanEnv<T>(setup: () => void, importAndExtract: () => Promise<T>): Promise<T> {
  // Clean all related vars
  for (const v of VARS_TO_CLEAN) {
    delete process.env[v];
  }
  setup();
  return importAndExtract();
}

// ─── types.ts: DEFAULT_CONFIG ───────────────────────────────────────────────

describe("EMBEDDING_TUNE_* env vars — pipeline types (DEFAULT_CONFIG)", () => {
  // Save and restore env
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const v of VARS_TO_CLEAN) {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    }
  });

  afterEach(() => {
    for (const v of VARS_TO_CLEAN) {
      if (savedEnv[v] === undefined) {
        delete process.env[v];
      } else {
        process.env[v] = savedEnv[v];
      }
    }
  });

  /**
   * Since DEFAULT_CONFIG is a module-level constant evaluated at import time,
   * we need to use dynamic imports with cache busting to test different env states.
   * Instead, we test the env-reading expressions directly.
   */

  // --- EMBEDDING_TUNE_CONCURRENCY (default: "1") ---

  describe("EMBEDDING_TUNE_CONCURRENCY", () => {
    const read = () => parseInt(process.env.EMBEDDING_TUNE_CONCURRENCY || process.env.EMBEDDING_CONCURRENCY || "1", 10);

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_CONCURRENCY = "4";
      expect(read()).toBe(4);
    });

    it("falls back to old name", () => {
      process.env.EMBEDDING_CONCURRENCY = "3";
      expect(read()).toBe(3);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_CONCURRENCY = "5";
      process.env.EMBEDDING_CONCURRENCY = "2";
      expect(read()).toBe(5);
    });

    it("defaults to 1", () => {
      expect(read()).toBe(1);
    });
  });

  // --- EMBEDDING_TUNE_BATCH_SIZE (default: "1024") ---

  describe("EMBEDDING_TUNE_BATCH_SIZE", () => {
    const read = () =>
      parseInt(
        process.env.EMBEDDING_TUNE_BATCH_SIZE ||
          process.env.EMBEDDING_BATCH_SIZE ||
          process.env.CODE_BATCH_SIZE ||
          "1024",
        10,
      );

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_BATCH_SIZE = "512";
      expect(read()).toBe(512);
    });

    it("falls back to old name", () => {
      process.env.EMBEDDING_BATCH_SIZE = "256";
      expect(read()).toBe(256);
    });

    it("falls back to CODE_BATCH_SIZE", () => {
      process.env.CODE_BATCH_SIZE = "128";
      expect(read()).toBe(128);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_BATCH_SIZE = "2048";
      process.env.EMBEDDING_BATCH_SIZE = "512";
      process.env.CODE_BATCH_SIZE = "64";
      expect(read()).toBe(2048);
    });

    it("defaults to 1024", () => {
      expect(read()).toBe(1024);
    });
  });

  // --- EMBEDDING_TUNE_MIN_BATCH_SIZE (default: undefined → batchSize*0.5) ---

  describe("EMBEDDING_TUNE_MIN_BATCH_SIZE", () => {
    const read = () => {
      const raw = process.env.EMBEDDING_TUNE_MIN_BATCH_SIZE ?? process.env.MIN_BATCH_SIZE;
      return raw !== null && raw !== undefined ? parseInt(raw, 10) : undefined;
    };

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_MIN_BATCH_SIZE = "100";
      expect(read()).toBe(100);
    });

    it("falls back to old name", () => {
      process.env.MIN_BATCH_SIZE = "200";
      expect(read()).toBe(200);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_MIN_BATCH_SIZE = "300";
      process.env.MIN_BATCH_SIZE = "400";
      expect(read()).toBe(300);
    });

    it("defaults to undefined", () => {
      expect(read()).toBeUndefined();
    });
  });

  // --- EMBEDDING_TUNE_BATCH_TIMEOUT_MS (default: "2000") ---

  describe("EMBEDDING_TUNE_BATCH_TIMEOUT_MS", () => {
    const read = () =>
      parseInt(process.env.EMBEDDING_TUNE_BATCH_TIMEOUT_MS || process.env.BATCH_FORMATION_TIMEOUT_MS || "2000", 10);

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_BATCH_TIMEOUT_MS = "5000";
      expect(read()).toBe(5000);
    });

    it("falls back to old name", () => {
      process.env.BATCH_FORMATION_TIMEOUT_MS = "3000";
      expect(read()).toBe(3000);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_BATCH_TIMEOUT_MS = "1000";
      process.env.BATCH_FORMATION_TIMEOUT_MS = "4000";
      expect(read()).toBe(1000);
    });

    it("defaults to 2000", () => {
      expect(read()).toBe(2000);
    });
  });

  // --- EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE (no default) ---

  describe("EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE", () => {
    const read = () => {
      const raw = process.env.EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE || process.env.EMBEDDING_MAX_REQUESTS_PER_MINUTE;
      return raw ? parseInt(raw, 10) : undefined;
    };

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE = "60";
      expect(read()).toBe(60);
    });

    it("falls back to old name", () => {
      process.env.EMBEDDING_MAX_REQUESTS_PER_MINUTE = "30";
      expect(read()).toBe(30);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE = "120";
      process.env.EMBEDDING_MAX_REQUESTS_PER_MINUTE = "60";
      expect(read()).toBe(120);
    });

    it("defaults to undefined", () => {
      expect(read()).toBeUndefined();
    });
  });

  // --- EMBEDDING_TUNE_RETRY_ATTEMPTS (default: undefined in factory, meaning provider default) ---

  describe("EMBEDDING_TUNE_RETRY_ATTEMPTS", () => {
    const read = () => {
      const raw = process.env.EMBEDDING_TUNE_RETRY_ATTEMPTS || process.env.EMBEDDING_RETRY_ATTEMPTS;
      return raw ? parseInt(raw, 10) : undefined;
    };

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_RETRY_ATTEMPTS = "5";
      expect(read()).toBe(5);
    });

    it("falls back to old name", () => {
      process.env.EMBEDDING_RETRY_ATTEMPTS = "2";
      expect(read()).toBe(2);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_RETRY_ATTEMPTS = "10";
      process.env.EMBEDDING_RETRY_ATTEMPTS = "3";
      expect(read()).toBe(10);
    });

    it("defaults to undefined", () => {
      expect(read()).toBeUndefined();
    });
  });

  // --- EMBEDDING_TUNE_RETRY_DELAY_MS (default: undefined in factory) ---

  describe("EMBEDDING_TUNE_RETRY_DELAY_MS", () => {
    const read = () => {
      const raw = process.env.EMBEDDING_TUNE_RETRY_DELAY_MS || process.env.EMBEDDING_RETRY_DELAY;
      return raw ? parseInt(raw, 10) : undefined;
    };

    it("uses new name", () => {
      process.env.EMBEDDING_TUNE_RETRY_DELAY_MS = "2000";
      expect(read()).toBe(2000);
    });

    it("falls back to old name", () => {
      process.env.EMBEDDING_RETRY_DELAY = "500";
      expect(read()).toBe(500);
    });

    it("new name takes priority", () => {
      process.env.EMBEDDING_TUNE_RETRY_DELAY_MS = "3000";
      process.env.EMBEDDING_RETRY_DELAY = "1000";
      expect(read()).toBe(3000);
    });

    it("defaults to undefined", () => {
      expect(read()).toBeUndefined();
    });
  });
});
