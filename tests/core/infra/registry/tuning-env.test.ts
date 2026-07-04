/**
 * TUNING_ENV_GROUPS — canonical/alias vocabulary of the registry tuning
 * snapshot (tea-rags-mcp-9vpnz).
 *
 * Groups mirror the alias families of bootstrap/config/parse.ts so that:
 * - the snapshot builder (bootstrap/config/tuning-snapshot.ts) emits one
 *   CANONICAL key per group at its parsed effective value, and
 * - replay (cli/registry-env-replay.ts) can skip a whole group when ANY
 *   spelling is set in the ambient env (env > registry per-key, alias-aware).
 *
 * ADAPTIVE_DEFAULT_TUNING_KEYS marks the groups whose code default is
 * runtime-adaptive (GPU calibration / per-language sizing / embedded-mode
 * tuning) — materialized only when the user explicitly set them.
 */

import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_DEFAULT_TUNING_KEYS,
  TUNING_ENV_ALLOWLIST,
  TUNING_ENV_GROUPS,
} from "../../../../src/core/infra/registry/tuning-env.js";

describe("TUNING_ENV_GROUPS", () => {
  it("mirrors the alias families of bootstrap/config/parse.ts", () => {
    const byCanonical = new Map(TUNING_ENV_GROUPS.map((g) => [g.canonical, [...g.aliases]]));
    expect(byCanonical.get("GIT_ADAPTER")).toEqual([]);
    expect(byCanonical.get("TRAJECTORY_GIT_ENABLED")).toEqual(["CODE_ENABLE_GIT_METADATA"]);
    expect(byCanonical.get("TRAJECTORY_GIT_CHUNK_CONCURRENCY")).toEqual(["GIT_CHUNK_CONCURRENCY"]);
    expect(byCanonical.get("INGEST_PIPELINE_CONCURRENCY")).toEqual([
      "EMBEDDING_TUNE_CONCURRENCY",
      "EMBEDDING_CONCURRENCY",
    ]);
    expect(byCanonical.get("INGEST_TUNE_CHUNKER_POOL_SIZE")).toEqual(["CHUNKER_POOL_SIZE"]);
    expect(byCanonical.get("INGEST_CHUNK_SIZE")).toEqual(["CODE_CHUNK_SIZE"]);
    expect(byCanonical.get("EMBEDDING_TUNE_BATCH_SIZE")).toEqual(["EMBEDDING_BATCH_SIZE", "CODE_BATCH_SIZE"]);
    // CODE_BATCH_SIZE is deliberately a member of TWO groups (parse.ts feeds it
    // into both embedding batchSize and qdrant upsertBatchSize).
    expect(byCanonical.get("QDRANT_TUNE_UPSERT_BATCH_SIZE")).toEqual(["QDRANT_UPSERT_BATCH_SIZE", "CODE_BATCH_SIZE"]);
    expect(byCanonical.get("QDRANT_TUNE_DELETE_BATCH_SIZE")).toEqual(["QDRANT_DELETE_BATCH_SIZE", "DELETE_BATCH_SIZE"]);
  });

  it("has unique canonical keys", () => {
    const canonicals = TUNING_ENV_GROUPS.map((g) => g.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it("covers the canonical tuning families from bootstrap/config/parse.ts", () => {
    const canonicals = new Set(TUNING_ENV_GROUPS.map((g) => g.canonical));
    for (const key of [
      "GIT_ADAPTER",
      "TRAJECTORY_GIT_ENABLED",
      "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
      "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
      "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS",
      "TRAJECTORY_GIT_SESSION_GAP_MINUTES",
      "INGEST_PIPELINE_CONCURRENCY",
      "INGEST_TUNE_CHUNKER_POOL_SIZE",
      "INGEST_TUNE_FILE_CONCURRENCY",
      "INGEST_TUNE_IO_CONCURRENCY",
      "INGEST_TUNE_ENRICHMENT_POOL_SIZE",
      "INGEST_CHUNK_SIZE",
      "INGEST_CHUNK_OVERLAP",
      "EMBEDDING_TUNE_BATCH_SIZE",
      "EMBEDDING_TUNE_MIN_BATCH_SIZE",
      "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
      "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
      "EMBEDDING_TUNE_RETRY_ATTEMPTS",
      "EMBEDDING_TUNE_RETRY_DELAY_MS",
      "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_ATTEMPTS",
      "EMBEDDING_TUNE_HEALTH_CHECK_RETRY_DELAY_MS",
      "EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS",
      "EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS",
      "QDRANT_TUNE_UPSERT_BATCH_SIZE",
      "QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS",
      "QDRANT_TUNE_UPSERT_ORDERING",
      "QDRANT_TUNE_DELETE_BATCH_SIZE",
      "QDRANT_TUNE_DELETE_CONCURRENCY",
      "QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS",
      "QDRANT_QUANTIZATION_SCALAR",
      "QDRANT_TURBO_QUANT",
      "QDRANT_MAX_RESIDENT_MEMORY_PERCENT",
      "QDRANT_SEARCH_MAX_BATCHSIZE",
      "QDRANT_LOW_MEMORY",
    ]) {
      expect(canonicals).toContain(key);
    }
  });

  it("excludes identity/endpoint/secret config that has dedicated handling", () => {
    for (const key of [
      "QDRANT_URL",
      "QDRANT_API_KEY",
      "EMBEDDING_MODEL",
      "EMBEDDING_BASE_URL",
      "EMBEDDING_FALLBACK_URL",
      "CODEGRAPH_ENABLED",
      "OPENAI_API_KEY",
      "DEBUG",
    ]) {
      expect(TUNING_ENV_ALLOWLIST).not.toContain(key);
    }
  });
});

describe("TUNING_ENV_ALLOWLIST", () => {
  it("is derived from the groups — every canonical and alias spelling, nothing else", () => {
    const expected = new Set(TUNING_ENV_GROUPS.flatMap((g) => [g.canonical, ...g.aliases]));
    expect(new Set(TUNING_ENV_ALLOWLIST)).toEqual(expected);
  });
});

describe("ADAPTIVE_DEFAULT_TUNING_KEYS", () => {
  it("marks exactly the four runtime-adaptive groups (matching the userSet* config flags)", () => {
    expect([...ADAPTIVE_DEFAULT_TUNING_KEYS].sort()).toEqual([
      "EMBEDDING_TUNE_BATCH_SIZE",
      "INGEST_CHUNK_SIZE",
      "QDRANT_TUNE_DELETE_BATCH_SIZE",
      "QDRANT_TUNE_DELETE_CONCURRENCY",
    ]);
  });

  it("every adaptive key is a canonical group key", () => {
    const canonicals = new Set(TUNING_ENV_GROUPS.map((g) => g.canonical));
    for (const key of ADAPTIVE_DEFAULT_TUNING_KEYS) {
      expect(canonicals).toContain(key);
    }
  });
});
