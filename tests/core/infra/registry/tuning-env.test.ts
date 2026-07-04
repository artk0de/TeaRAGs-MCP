/**
 * captureTuningEnv — curated tuning env snapshot for the project registry.
 *
 * The allowlist mirrors the tuning env vars read by bootstrap/config/parse.ts
 * (canonical names AND deprecated aliases). Only vars actually SET in the
 * given env are captured — no code defaults materialized — with ONE deliberate
 * exception: GIT_ADAPTER is always pinned at its resolved value (spec
 * decision: adapter choice is per-project explicit, ambient env must not
 * silently flip it).
 */

import { describe, expect, it } from "vitest";

import { captureTuningEnv, TUNING_ENV_ALLOWLIST } from "../../../../src/core/infra/registry/tuning-env.js";

describe("captureTuningEnv", () => {
  it("pins only GIT_ADAPTER for an env with no allowlisted vars set (no other defaults materialized)", () => {
    expect(captureTuningEnv({})).toEqual({ GIT_ADAPTER: "git" });
  });

  it("captures only allowlisted vars that are set", () => {
    const tuning = captureTuningEnv({
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
      INGEST_TUNE_FILE_CONCURRENCY: "25",
      QDRANT_TUNE_UPSERT_BATCH_SIZE: "512",
      // Not tuning — identity/endpoint config with dedicated registry fields:
      QDRANT_URL: "http://localhost:6333",
      EMBEDDING_MODEL: "jina",
      CODEGRAPH_ENABLED: "true",
      // Not tuning — ambient shell noise:
      PATH: "/usr/bin",
      DEBUG: "true",
    });
    expect(tuning).toEqual({
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
      INGEST_TUNE_FILE_CONCURRENCY: "25",
      QDRANT_TUNE_UPSERT_BATCH_SIZE: "512",
      GIT_ADAPTER: "git", // force-pinned resolved default
    });
  });

  it("captures deprecated aliases verbatim (replay reproduces the same effective config)", () => {
    const tuning = captureTuningEnv({
      GIT_CHUNK_CONCURRENCY: "3",
      CHUNKER_POOL_SIZE: "1",
      EMBEDDING_BATCH_SIZE: "64",
      EMBEDDING_CONCURRENCY: "4",
      BATCH_FORMATION_TIMEOUT_MS: "1500",
      QDRANT_UPSERT_BATCH_SIZE: "256",
      CODE_CHUNK_SIZE: "900",
      CODE_CHUNK_OVERLAP: "100",
    });
    expect(tuning).toEqual({
      GIT_CHUNK_CONCURRENCY: "3",
      CHUNKER_POOL_SIZE: "1",
      EMBEDDING_BATCH_SIZE: "64",
      EMBEDDING_CONCURRENCY: "4",
      BATCH_FORMATION_TIMEOUT_MS: "1500",
      QDRANT_UPSERT_BATCH_SIZE: "256",
      CODE_CHUNK_SIZE: "900",
      CODE_CHUNK_OVERLAP: "100",
      GIT_ADAPTER: "git", // force-pinned resolved default
    });
  });

  it("skips empty-string values (envWithFallback treats them as unset)", () => {
    expect(
      captureTuningEnv({
        TRAJECTORY_GIT_CHUNK_CONCURRENCY: "",
        INGEST_TUNE_IO_CONCURRENCY: "40",
      }),
    ).toEqual({ INGEST_TUNE_IO_CONCURRENCY: "40", GIT_ADAPTER: "git" });
  });

  it("defaults to process.env when no env is given", () => {
    const saved = process.env.TRAJECTORY_GIT_SESSION_GAP_MINUTES;
    process.env.TRAJECTORY_GIT_SESSION_GAP_MINUTES = "45";
    try {
      expect(captureTuningEnv()?.TRAJECTORY_GIT_SESSION_GAP_MINUTES).toBe("45");
    } finally {
      if (saved === undefined) delete process.env.TRAJECTORY_GIT_SESSION_GAP_MINUTES;
      else process.env.TRAJECTORY_GIT_SESSION_GAP_MINUTES = saved;
    }
  });

  describe("GIT_ADAPTER force-pin (spec: adapter choice is pinned per-project explicitly)", () => {
    it("captures an explicit GIT_ADAPTER value verbatim", () => {
      expect(captureTuningEnv({ GIT_ADAPTER: "es-git" })).toEqual({ GIT_ADAPTER: "es-git" });
    });

    it("pins the resolved default when GIT_ADAPTER is empty-string (unset semantics)", () => {
      expect(captureTuningEnv({ GIT_ADAPTER: "" })).toEqual({ GIT_ADAPTER: "git" });
    });

    it("is allowlisted so an exported GIT_ADAPTER is captured by the generic loop", () => {
      expect(TUNING_ENV_ALLOWLIST).toContain("GIT_ADAPTER");
    });
  });

  describe("TUNING_ENV_ALLOWLIST", () => {
    it("covers the canonical tuning families from bootstrap/config/parse.ts", () => {
      for (const key of [
        "TRAJECTORY_GIT_ENABLED",
        "TRAJECTORY_GIT_CHUNK_CONCURRENCY",
        "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
        "INGEST_PIPELINE_CONCURRENCY",
        "INGEST_TUNE_CHUNKER_POOL_SIZE",
        "INGEST_TUNE_ENRICHMENT_POOL_SIZE",
        "INGEST_CHUNK_SIZE",
        "INGEST_CHUNK_OVERLAP",
        "EMBEDDING_TUNE_BATCH_SIZE",
        "EMBEDDING_TUNE_BATCH_TIMEOUT_MS",
        "QDRANT_TUNE_UPSERT_BATCH_SIZE",
        "QDRANT_TUNE_DELETE_CONCURRENCY",
        "QDRANT_LOW_MEMORY",
      ]) {
        expect(TUNING_ENV_ALLOWLIST).toContain(key);
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
});
