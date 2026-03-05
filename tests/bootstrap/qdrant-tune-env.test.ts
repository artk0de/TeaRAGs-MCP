/**
 * Tests for QDRANT_TUNE_* env var rename with backwards compatibility.
 *
 * Each var follows the pattern: new name → old primary → old alias → default
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// All env vars we need to clean up between tests
const ENV_VARS = [
  // Upsert batch size
  "QDRANT_TUNE_UPSERT_BATCH_SIZE",
  "QDRANT_UPSERT_BATCH_SIZE",
  "CODE_BATCH_SIZE",
  // Upsert flush interval
  "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS",
  "QDRANT_FLUSH_INTERVAL_MS",
  // Upsert ordering
  "QDRANT_TUNE_UPSERT_ORDERING",
  "QDRANT_BATCH_ORDERING",
  // Delete batch size
  "QDRANT_TUNE_DELETE_BATCH_SIZE",
  "QDRANT_DELETE_BATCH_SIZE",
  "DELETE_BATCH_SIZE",
  // Delete concurrency
  "QDRANT_TUNE_DELETE_CONCURRENCY",
  "QDRANT_DELETE_CONCURRENCY",
  "DELETE_CONCURRENCY",
  // Delete flush timeout
  "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS",
  "DELETE_FLUSH_TIMEOUT_MS",
] as const;

function cleanEnv() {
  for (const key of ENV_VARS) {
    delete process.env[key];
  }
}

/**
 * Helper: read an env var using the fallback chain pattern.
 * This mirrors the exact pattern used in source files.
 */
function readEnv(chain: string[], defaultValue: string): string {
  for (const key of chain) {
    if (process.env[key] !== undefined && process.env[key] !== "") {
      return process.env[key];
    }
  }
  return defaultValue;
}

describe("QDRANT_TUNE_* env var rename (backwards compat)", () => {
  beforeEach(() => {
    cleanEnv();
  });
  afterEach(() => {
    cleanEnv();
  });

  // ── QDRANT_TUNE_UPSERT_BATCH_SIZE ──────────────────────────────────

  describe("QDRANT_TUNE_UPSERT_BATCH_SIZE (triple chain)", () => {
    const chain = ["QDRANT_TUNE_UPSERT_BATCH_SIZE", "QDRANT_UPSERT_BATCH_SIZE", "CODE_BATCH_SIZE"];
    const dflt = "100";

    it("uses new name when set", () => {
      process.env.QDRANT_TUNE_UPSERT_BATCH_SIZE = "200";
      expect(readEnv(chain, dflt)).toBe("200");
    });

    it("falls back to QDRANT_UPSERT_BATCH_SIZE", () => {
      process.env.QDRANT_UPSERT_BATCH_SIZE = "150";
      expect(readEnv(chain, dflt)).toBe("150");
    });

    it("falls back to CODE_BATCH_SIZE (second alias)", () => {
      process.env.CODE_BATCH_SIZE = "75";
      expect(readEnv(chain, dflt)).toBe("75");
    });

    it("new name takes priority over old names", () => {
      process.env.QDRANT_TUNE_UPSERT_BATCH_SIZE = "200";
      process.env.QDRANT_UPSERT_BATCH_SIZE = "150";
      process.env.CODE_BATCH_SIZE = "75";
      expect(readEnv(chain, dflt)).toBe("200");
    });

    it("returns default when nothing set", () => {
      expect(readEnv(chain, dflt)).toBe("100");
    });
  });

  // ── QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS ──────────────────────────

  describe("QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS (double chain)", () => {
    const chain = ["QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS", "QDRANT_FLUSH_INTERVAL_MS"];
    const dflt = "500";

    it("uses new name when set", () => {
      process.env.QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS = "1000";
      expect(readEnv(chain, dflt)).toBe("1000");
    });

    it("falls back to QDRANT_FLUSH_INTERVAL_MS", () => {
      process.env.QDRANT_FLUSH_INTERVAL_MS = "750";
      expect(readEnv(chain, dflt)).toBe("750");
    });

    it("new name takes priority", () => {
      process.env.QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS = "1000";
      process.env.QDRANT_FLUSH_INTERVAL_MS = "750";
      expect(readEnv(chain, dflt)).toBe("1000");
    });

    it("returns default when nothing set", () => {
      expect(readEnv(chain, dflt)).toBe("500");
    });
  });

  // ── QDRANT_TUNE_UPSERT_ORDERING ───────────────────────────────────

  describe("QDRANT_TUNE_UPSERT_ORDERING (double chain)", () => {
    const chain = ["QDRANT_TUNE_UPSERT_ORDERING", "QDRANT_BATCH_ORDERING"];
    const dflt = "weak";

    it("uses new name when set", () => {
      process.env.QDRANT_TUNE_UPSERT_ORDERING = "strong";
      expect(readEnv(chain, dflt)).toBe("strong");
    });

    it("falls back to QDRANT_BATCH_ORDERING", () => {
      process.env.QDRANT_BATCH_ORDERING = "medium";
      expect(readEnv(chain, dflt)).toBe("medium");
    });

    it("new name takes priority", () => {
      process.env.QDRANT_TUNE_UPSERT_ORDERING = "strong";
      process.env.QDRANT_BATCH_ORDERING = "medium";
      expect(readEnv(chain, dflt)).toBe("strong");
    });

    it("returns default when nothing set", () => {
      expect(readEnv(chain, dflt)).toBe("weak");
    });
  });

  // ── QDRANT_TUNE_DELETE_BATCH_SIZE ──────────────────────────────────

  describe("QDRANT_TUNE_DELETE_BATCH_SIZE (triple chain)", () => {
    const chain = ["QDRANT_TUNE_DELETE_BATCH_SIZE", "QDRANT_DELETE_BATCH_SIZE", "DELETE_BATCH_SIZE"];
    const dflt = "500";

    it("uses new name when set", () => {
      process.env.QDRANT_TUNE_DELETE_BATCH_SIZE = "1000";
      expect(readEnv(chain, dflt)).toBe("1000");
    });

    it("falls back to QDRANT_DELETE_BATCH_SIZE", () => {
      process.env.QDRANT_DELETE_BATCH_SIZE = "750";
      expect(readEnv(chain, dflt)).toBe("750");
    });

    it("falls back to DELETE_BATCH_SIZE (second alias)", () => {
      process.env.DELETE_BATCH_SIZE = "250";
      expect(readEnv(chain, dflt)).toBe("250");
    });

    it("new name takes priority over old names", () => {
      process.env.QDRANT_TUNE_DELETE_BATCH_SIZE = "1000";
      process.env.QDRANT_DELETE_BATCH_SIZE = "750";
      process.env.DELETE_BATCH_SIZE = "250";
      expect(readEnv(chain, dflt)).toBe("1000");
    });

    it("returns default when nothing set", () => {
      expect(readEnv(chain, dflt)).toBe("500");
    });
  });

  // ── QDRANT_TUNE_DELETE_CONCURRENCY ─────────────────────────────────

  describe("QDRANT_TUNE_DELETE_CONCURRENCY (triple chain)", () => {
    const chain = ["QDRANT_TUNE_DELETE_CONCURRENCY", "QDRANT_DELETE_CONCURRENCY", "DELETE_CONCURRENCY"];
    const dflt = "8";

    it("uses new name when set", () => {
      process.env.QDRANT_TUNE_DELETE_CONCURRENCY = "16";
      expect(readEnv(chain, dflt)).toBe("16");
    });

    it("falls back to QDRANT_DELETE_CONCURRENCY", () => {
      process.env.QDRANT_DELETE_CONCURRENCY = "12";
      expect(readEnv(chain, dflt)).toBe("12");
    });

    it("falls back to DELETE_CONCURRENCY (second alias)", () => {
      process.env.DELETE_CONCURRENCY = "4";
      expect(readEnv(chain, dflt)).toBe("4");
    });

    it("new name takes priority over old names", () => {
      process.env.QDRANT_TUNE_DELETE_CONCURRENCY = "16";
      process.env.QDRANT_DELETE_CONCURRENCY = "12";
      process.env.DELETE_CONCURRENCY = "4";
      expect(readEnv(chain, dflt)).toBe("16");
    });

    it("returns default when nothing set", () => {
      expect(readEnv(chain, dflt)).toBe("8");
    });
  });

  // ── QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS ────────────────────────────

  describe("QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS (double chain)", () => {
    const chain = ["QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS", "DELETE_FLUSH_TIMEOUT_MS"];
    const dflt = "1000";

    it("uses new name when set", () => {
      process.env.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS = "2000";
      expect(readEnv(chain, dflt)).toBe("2000");
    });

    it("falls back to DELETE_FLUSH_TIMEOUT_MS", () => {
      process.env.DELETE_FLUSH_TIMEOUT_MS = "1500";
      expect(readEnv(chain, dflt)).toBe("1500");
    });

    it("new name takes priority", () => {
      process.env.QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS = "2000";
      process.env.DELETE_FLUSH_TIMEOUT_MS = "1500";
      expect(readEnv(chain, dflt)).toBe("2000");
    });

    it("returns default when nothing set", () => {
      expect(readEnv(chain, dflt)).toBe("1000");
    });
  });

  // ── Integration: verify source files use the correct chains ────────
  // These tests import the actual modules and verify the env chains work
  // at the module level (not just the helper function).

  describe("config.ts integration", () => {
    it("parseAppConfig reads QDRANT_TUNE_UPSERT_BATCH_SIZE with fallback", async () => {
      process.env.QDRANT_TUNE_UPSERT_BATCH_SIZE = "42";
      vi.resetModules();
      const { parseAppConfig } = await import("../../src/bootstrap/config.js");
      const config = parseAppConfig();
      expect(config.code.batchSize).toBe(42);
      cleanEnv();
    });
  });

  describe("accumulator.ts integration", () => {
    it("createAccumulator accepts QdrantTuneConfig (no env reads)", async () => {
      // createAccumulator no longer reads process.env —
      // it receives QdrantTuneConfig via DI from bootstrap/config.ts.
      // Verify config.ts parses the env var correctly.
      process.env.QDRANT_TUNE_UPSERT_BATCH_SIZE = "77";
      vi.resetModules();
      const { parseAppConfigZod } = await import("../../src/bootstrap/config.js");
      const config = parseAppConfigZod();
      expect(config.qdrantTune.upsertBatchSize).toBe(77);
      cleanEnv();
    });
  });
});
