/**
 * Tests for INGEST_* env var naming convention.
 *
 * Verifies: new name works, old name works as fallback, new name takes priority, default when nothing set.
 * Special: INGEST_ENABLE_AST uses Zod booleanFromEnvWithDefault(true) — "true"/"1" enables, default true.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Env var mapping for parseAppConfig: [newName, oldName, defaultValue, configKey]
 * These are read in config.ts via parseInt or direct string comparison.
 */
const CONFIG_MAPPINGS: [string, string, string, string][] = [
  ["INGEST_CHUNK_SIZE", "CODE_CHUNK_SIZE", "2500", "chunkSize"],
  ["INGEST_CHUNK_OVERLAP", "CODE_CHUNK_OVERLAP", "300", "chunkOverlap"],
  ["INGEST_DEFAULT_SEARCH_LIMIT", "CODE_SEARCH_LIMIT", "5", "defaultSearchLimit"],
];

/** Boolean env var: CODE_ENABLE_HYBRID → INGEST_ENABLE_HYBRID (=== "true") */
const HYBRID_NEW = "INGEST_ENABLE_HYBRID";
const HYBRID_OLD = "CODE_ENABLE_HYBRID";

/** Boolean env var: CODE_ENABLE_AST → INGEST_ENABLE_AST (Zod: "true"/"1" → true, default true) */
const AST_NEW = "INGEST_ENABLE_AST";
const AST_OLD = "CODE_ENABLE_AST";

/**
 * Env var mapping for runtime reads (not in config.ts):
 * [newName, oldName, defaultValue, description]
 */
const RUNTIME_MAPPINGS: [string, string, string, string][] = [
  ["INGEST_TUNE_CHUNKER_POOL_SIZE", "CHUNKER_POOL_SIZE", "4", "chunker pool size"],
  ["INGEST_TUNE_FILE_CONCURRENCY", "FILE_PROCESSING_CONCURRENCY", "50", "file processing concurrency"],
  ["INGEST_TUNE_IO_CONCURRENCY", "MAX_IO_CONCURRENCY", "50", "max IO concurrency"],
];

/** All env var names involved (for cleanup) */
const ALL_KEYS = [
  ...CONFIG_MAPPINGS.flatMap(([n, o]) => [n, o]),
  HYBRID_NEW,
  HYBRID_OLD,
  AST_NEW,
  AST_OLD,
  ...RUNTIME_MAPPINGS.flatMap(([n, o]) => [n, o]),
];

describe("INGEST env var naming", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ALL_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ALL_KEYS) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe("parseAppConfig — numeric vars", () => {
    for (const [newName, oldName, defaultVal, configKey] of CONFIG_MAPPINGS) {
      describe(newName, () => {
        it("should read new name", async () => {
          process.env[newName] = "999";

          const { parseAppConfig } = await freshImport();
          const config = parseAppConfig();

          expect(({ ...config.ingestCode, ...config.searchCode } as Record<string, unknown>)[configKey]).toBe(999);
        });

        it("should fall back to old name", async () => {
          process.env[oldName] = "888";

          const { parseAppConfig } = await freshImport();
          const config = parseAppConfig();

          expect(({ ...config.ingestCode, ...config.searchCode } as Record<string, unknown>)[configKey]).toBe(888);
        });

        it("should prefer new name over old name", async () => {
          process.env[newName] = "111";
          process.env[oldName] = "222";

          const { parseAppConfig } = await freshImport();
          const config = parseAppConfig();

          expect(({ ...config.ingestCode, ...config.searchCode } as Record<string, unknown>)[configKey]).toBe(111);
        });

        it(`should default to ${defaultVal} when nothing set`, async () => {
          const { parseAppConfig } = await freshImport();
          const config = parseAppConfig();

          expect(({ ...config.ingestCode, ...config.searchCode } as Record<string, unknown>)[configKey]).toBe(
            parseInt(defaultVal, 10),
          );
        });
      });
    }
  });

  describe("parseAppConfig — INGEST_ENABLE_HYBRID (boolean === 'true')", () => {
    it("should read new name", async () => {
      process.env[HYBRID_NEW] = "true";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.ingestCode.enableHybridSearch).toBe(true);
    });

    it("should fall back to old name", async () => {
      process.env[HYBRID_OLD] = "true";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.ingestCode.enableHybridSearch).toBe(true);
    });

    it("should prefer new name over old name", async () => {
      process.env[HYBRID_NEW] = "false";
      process.env[HYBRID_OLD] = "true";

      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.ingestCode.enableHybridSearch).toBe(false);
    });

    it("should default to false when nothing set", async () => {
      const { parseAppConfig } = await freshImport();
      const config = parseAppConfig();

      expect(config.ingestCode.enableHybridSearch).toBe(false);
    });
  });

  describe("parseAppConfigZod — INGEST_ENABLE_AST (Zod: 'true'/'1' enables, default true)", () => {
    it("should read new name — 'false' disables", async () => {
      process.env[AST_NEW] = "false";

      const { parseAppConfigZod } = await freshImport();
      const { ingest } = parseAppConfigZod();

      expect(ingest.enableAST).toBe(false);
    });

    it("should read new name — 'true' enables", async () => {
      process.env[AST_NEW] = "true";

      const { parseAppConfigZod } = await freshImport();
      const { ingest } = parseAppConfigZod();

      expect(ingest.enableAST).toBe(true);
    });

    it("should read new name — unrecognized value disables (Zod strict)", async () => {
      process.env[AST_NEW] = "whatever";

      const { parseAppConfigZod } = await freshImport();
      const { ingest } = parseAppConfigZod();

      expect(ingest.enableAST).toBe(false);
    });

    it("should fall back to old name — 'false' disables", async () => {
      process.env[AST_OLD] = "false";

      const { parseAppConfigZod } = await freshImport();
      const { ingest } = parseAppConfigZod();

      expect(ingest.enableAST).toBe(false);
    });

    it("should prefer new name over old name", async () => {
      process.env[AST_NEW] = "true";
      process.env[AST_OLD] = "false";

      const { parseAppConfigZod } = await freshImport();
      const { ingest } = parseAppConfigZod();

      expect(ingest.enableAST).toBe(true);
    });

    it("should default to true (enabled) when nothing set", async () => {
      const { parseAppConfigZod } = await freshImport();
      const { ingest } = parseAppConfigZod();

      expect(ingest.enableAST).toBe(true);
    });
  });

  describe("runtime env vars — fallback chains", () => {
    for (const [newName, oldName, defaultVal, description] of RUNTIME_MAPPINGS) {
      describe(`${newName} (${description})`, () => {
        it("should read new name", () => {
          process.env[newName] = "77";

          const val = parseInt(process.env[newName] || process.env[oldName] || defaultVal, 10);
          expect(val).toBe(77);
        });

        it("should fall back to old name", () => {
          process.env[oldName] = "88";

          const val = parseInt(process.env[newName] || process.env[oldName] || defaultVal, 10);
          expect(val).toBe(88);
        });

        it("should prefer new name over old name", () => {
          process.env[newName] = "11";
          process.env[oldName] = "22";

          const val = parseInt(process.env[newName] || process.env[oldName] || defaultVal, 10);
          expect(val).toBe(11);
        });

        it(`should default to ${defaultVal} when nothing set`, () => {
          const val = parseInt(process.env[newName] || process.env[oldName] || defaultVal, 10);
          expect(val).toBe(parseInt(defaultVal, 10));
        });
      });
    }
  });
});

/** Fresh import of config.ts to pick up env var changes */
async function freshImport() {
  const mod = await import("../../src/bootstrap/config/index.js");
  return mod;
}
