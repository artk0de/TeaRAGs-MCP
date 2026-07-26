/**
 * REGISTRY_ENV_GROUPS — canonical/alias vocabulary of the FULL env surface
 * persisted to and replayed from the project registry (tea-rags-mcp-9vpnz).
 *
 * ONE general rule (`outer env > project registry env > code default`), one
 * mechanism, no "tuning" category. Groups mirror the alias families of
 * bootstrap/config/parse.ts so that:
 * - the snapshot builder (bootstrap/config/env-snapshot.ts) emits one
 *   CANONICAL key per group at its parsed effective value, and
 * - replay (cli/registry-env-replay.ts) can skip a whole group when ANY
 *   spelling is set in the ambient env.
 *
 * DEDICATED_FIELD_ENV_KEYS marks identity keys stored in dedicated
 * CollectionEntry fields; ADAPTIVE_DEFAULT_ENV_KEYS marks the groups whose
 * code default is runtime-adaptive (materialized only when user-set). The
 * only env kinds outside the mechanism: secrets and server/process knobs.
 */

import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_DEFAULT_ENV_KEYS,
  DEDICATED_FIELD_ENV_KEYS,
  REGISTRY_ENV_ALLOWLIST,
  REGISTRY_ENV_GROUPS,
} from "../../../../../src/core/domains/maintenance/registry/env-groups.js";

describe("REGISTRY_ENV_GROUPS", () => {
  it("mirrors the alias families of bootstrap/config/parse.ts", () => {
    const byCanonical = new Map(REGISTRY_ENV_GROUPS.map((g) => [g.canonical, [...g.aliases]]));
    expect(byCanonical.get("GIT_ADAPTER")).toEqual([]);
    expect(byCanonical.get("EMBEDDING_BASE_URL")).toEqual(["OLLAMA_URL"]);
    expect(byCanonical.get("EMBEDDING_FALLBACK_URL")).toEqual(["OLLAMA_FALLBACK_URL"]);
    expect(byCanonical.get("TRAJECTORY_GIT_ENABLED")).toEqual(["CODE_ENABLE_GIT_METADATA"]);
    expect(byCanonical.get("TRAJECTORY_GIT_CHUNK_CONCURRENCY")).toEqual(["GIT_CHUNK_CONCURRENCY"]);
    expect(byCanonical.get("INGEST_ENABLE_AST")).toEqual(["CODE_ENABLE_AST"]);
    expect(byCanonical.get("INGEST_ENABLE_HYBRID")).toEqual(["CODE_ENABLE_HYBRID"]);
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
    const canonicals = REGISTRY_ENV_GROUPS.map((g) => g.canonical);
    expect(new Set(canonicals).size).toBe(canonicals.length);
  });

  it("covers the FULL indexing env surface: identity, modes, trajectory, ingest, codegraph, tuning", () => {
    const canonicals = new Set(REGISTRY_ENV_GROUPS.map((g) => g.canonical));
    for (const key of [
      // vcs
      "GIT_ADAPTER",
      // embedding identity (dedicated fields, same replay rule)
      "EMBEDDING_MODEL",
      "EMBEDDING_BASE_URL",
      "EMBEDDING_FALLBACK_URL",
      "QDRANT_URL",
      "CODEGRAPH_ENABLED",
      // embedding operating modes
      "EMBEDDING_PROVIDER",
      "EMBEDDING_DIMENSIONS",
      "EMBEDDING_DEVICE",
      "OLLAMA_LEGACY_API",
      "OLLAMA_NUM_GPU",
      // trajectoryGit
      "TRAJECTORY_GIT_ENABLED",
      "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
      "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
      "TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS",
      "TRAJECTORY_GIT_SESSION_GAP_MINUTES",
      // ingest modes + tune + chunking
      "INGEST_ENABLE_AST",
      "INGEST_ENABLE_HYBRID",
      "CODE_TEST_PATHS",
      "INGEST_PIPELINE_CONCURRENCY",
      "INGEST_TUNE_CHUNKER_POOL_SIZE",
      "INGEST_TUNE_FILE_CONCURRENCY",
      "INGEST_TUNE_IO_CONCURRENCY",
      "INGEST_TUNE_ENRICHMENT_POOL_SIZE",
      "INGEST_CHUNK_SIZE",
      "INGEST_CHUNK_OVERLAP",
      // codegraph
      "CODEGRAPH_DB_PATH",
      "CODEGRAPH_DB_MEMORY_LIMIT",
      "CODEGRAPH_DB_MEMORY_LIMIT_MAX",
      "CODEGRAPH_DB_THREADS",
      "CODEGRAPH_EXCLUDE_TESTS",
      "CODEGRAPH_CUSTOM_EXCLUDE",
      "CODEGRAPH_AMBIGUOUS_RESOLVE_MODE",
      // embedding.tune
      "EMBEDDING_TUNE_BATCH_SIZE",
      "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
      "EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS",
      // qdrantTune
      "QDRANT_TUNE_UPSERT_BATCH_SIZE",
      "QDRANT_TUNE_DELETE_CONCURRENCY",
      "QDRANT_QUANTIZATION_SCALAR",
      "QDRANT_TURBO_QUANT",
      "QDRANT_LOW_MEMORY",
    ]) {
      expect(canonicals).toContain(key);
    }
  });

  it("excludes secrets and server/process knobs — the only env kinds outside the mechanism", () => {
    for (const key of [
      "QDRANT_API_KEY",
      "OPENAI_API_KEY",
      "COHERE_API_KEY",
      "VOYAGE_API_KEY",
      "DEBUG",
      "SERVER_TRANSPORT",
      "SERVER_HTTP_PORT",
      "SERVER_HTTP_TIMEOUT_MS",
      "SERVER_PROMPTS_FILE",
    ]) {
      expect(REGISTRY_ENV_ALLOWLIST).not.toContain(key);
    }
  });
});

describe("REGISTRY_ENV_ALLOWLIST", () => {
  it("is derived from the groups — every canonical and alias spelling, nothing else", () => {
    const expected = new Set(REGISTRY_ENV_GROUPS.flatMap((g) => [g.canonical, ...g.aliases]));
    expect(new Set(REGISTRY_ENV_ALLOWLIST)).toEqual(expected);
  });
});

describe("DEDICATED_FIELD_ENV_KEYS", () => {
  it("marks exactly the identity keys stored in dedicated CollectionEntry fields", () => {
    expect([...DEDICATED_FIELD_ENV_KEYS].sort()).toEqual([
      "CODEGRAPH_ENABLED",
      "EMBEDDING_BASE_URL",
      "EMBEDDING_FALLBACK_URL",
      "EMBEDDING_MODEL",
      "QDRANT_URL",
    ]);
  });

  it("every dedicated key is a canonical group key (same replay rule applies)", () => {
    const canonicals = new Set(REGISTRY_ENV_GROUPS.map((g) => g.canonical));
    for (const key of DEDICATED_FIELD_ENV_KEYS) {
      expect(canonicals).toContain(key);
    }
  });
});

describe("ADAPTIVE_DEFAULT_ENV_KEYS", () => {
  it("marks exactly the four runtime-adaptive groups (matching the userSet* config flags)", () => {
    expect([...ADAPTIVE_DEFAULT_ENV_KEYS].sort()).toEqual([
      "EMBEDDING_TUNE_BATCH_SIZE",
      "INGEST_CHUNK_SIZE",
      "QDRANT_TUNE_DELETE_BATCH_SIZE",
      "QDRANT_TUNE_DELETE_CONCURRENCY",
    ]);
  });

  it("every adaptive key is a canonical group key", () => {
    const canonicals = new Set(REGISTRY_ENV_GROUPS.map((g) => g.canonical));
    for (const key of ADAPTIVE_DEFAULT_ENV_KEYS) {
      expect(canonicals).toContain(key);
    }
  });
});
