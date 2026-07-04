/**
 * buildTuningEnvSnapshot — full effective tuning env set for the registry.
 *
 * Spec (tea-rags-mcp-9vpnz, user-confirmed): the project registry persists
 * ABSOLUTELY ALL tuning envs the indexing run effectively lived with —
 * code defaults MATERIALIZED, not just "actually set" keys — so a bare-env
 * reindex reproduces the last run's configuration exactly. Built from the
 * PARSED zod config (single source of truth for defaults, including
 * provider-conditional ones), keys normalized to CANONICAL spellings.
 *
 * Exception: keys whose code default is runtime-ADAPTIVE (GPU-calibrated
 * batch size, per-language chunk size, embedded-mode delete tuning) are
 * materialized only when the user explicitly set them (userSet* flags) —
 * pinning an adaptive value would freeze behavior the default recomputes
 * per run. Optional keys with no default are skipped while unset.
 */

import { describe, expect, it } from "vitest";

import {
  embeddingSchema,
  ingestSchema,
  qdrantTuneSchema,
  trajectoryGitSchema,
  vcsSchema,
} from "../../src/bootstrap/config/schemas.js";
import { buildTuningEnvSnapshot } from "../../src/bootstrap/config/tuning-snapshot.js";
import { ADAPTIVE_DEFAULT_TUNING_KEYS, TUNING_ENV_GROUPS } from "../../src/core/infra/registry/tuning-env.js";

const bareFlags = {
  userSetBatchSize: false,
  userSetChunkSize: false,
  userSetDeleteBatchSize: false,
  userSetDeleteConcurrency: false,
};

const bareConfig = () => ({
  vcs: vcsSchema.parse({}),
  trajectoryGit: trajectoryGitSchema.parse({}),
  ingest: ingestSchema.parse({ tune: {} }),
  embedding: embeddingSchema.parse({ tune: {} }),
  qdrantTune: qdrantTuneSchema.parse({}),
  flags: { ...bareFlags },
});

describe("buildTuningEnvSnapshot", () => {
  it("materializes code defaults for every statically-defaulted canonical key (bare config)", () => {
    const snapshot = buildTuningEnvSnapshot(bareConfig());
    expect(snapshot).toMatchObject({
      GIT_ADAPTER: "git",
      TRAJECTORY_GIT_ENABLED: "true",
      TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
      TRAJECTORY_GIT_LOG_TIMEOUT_MS: "60000",
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "10",
      TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS: "6",
      TRAJECTORY_GIT_CHUNK_TIMEOUT_MS: "120000",
      TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES: "10000",
      TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS: "false",
      TRAJECTORY_GIT_SESSION_GAP_MINUTES: "30",
      INGEST_PIPELINE_CONCURRENCY: "1",
      INGEST_TUNE_FILE_CONCURRENCY: "50",
      INGEST_TUNE_IO_CONCURRENCY: "50",
      INGEST_TUNE_ENRICHMENT_POOL_SIZE: "4",
      INGEST_CHUNK_OVERLAP: "300",
      EMBEDDING_TUNE_BATCH_TIMEOUT_MS: "2000",
      EMBEDDING_TUNE_RETRY_ATTEMPTS: "3",
      EMBEDDING_TUNE_RETRY_DELAY_MS: "1000",
      EMBEDDING_TUNE_HEALTH_CHECK_RETRY_ATTEMPTS: "3",
      EMBEDDING_TUNE_HEALTH_CHECK_RETRY_DELAY_MS: "250",
      EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS: "240000",
      EMBEDDING_TUNE_UNAVAILABLE_RETRY_BASE_DELAY_MS: "2000",
      QDRANT_TUNE_UPSERT_BATCH_SIZE: "100",
      QDRANT_TUNE_UPSERT_FLUSH_INTERVAL_MS: "500",
      QDRANT_TUNE_UPSERT_ORDERING: "weak",
      QDRANT_TUNE_DELETE_FLUSH_TIMEOUT_MS: "1000",
      QDRANT_QUANTIZATION_SCALAR: "false",
      QDRANT_TURBO_QUANT: "true",
      QDRANT_LOW_MEMORY: "false",
    });
    // Machine-adaptive but registry is machine-local: chunker pool size is
    // materialized at its resolved value (min(4, cpus-1) on this machine).
    expect(snapshot.INGEST_TUNE_CHUNKER_POOL_SIZE).toMatch(/^\d+$/);
  });

  it("omits runtime-adaptive keys when the user did not set them (flags false)", () => {
    const snapshot = buildTuningEnvSnapshot(bareConfig());
    for (const key of ADAPTIVE_DEFAULT_TUNING_KEYS) {
      expect(snapshot).not.toHaveProperty(key);
    }
  });

  it("materializes runtime-adaptive keys at their config values when user-set (flags true)", () => {
    const cfg = bareConfig();
    cfg.flags = {
      userSetBatchSize: true,
      userSetChunkSize: true,
      userSetDeleteBatchSize: true,
      userSetDeleteConcurrency: true,
    };
    const snapshot = buildTuningEnvSnapshot(cfg);
    expect(snapshot.EMBEDDING_TUNE_BATCH_SIZE).toBe("1024");
    expect(snapshot.INGEST_CHUNK_SIZE).toBe("2500");
    expect(snapshot.QDRANT_TUNE_DELETE_BATCH_SIZE).toBe("500");
    expect(snapshot.QDRANT_TUNE_DELETE_CONCURRENCY).toBe("8");
  });

  it("omits optional no-default keys while unset, includes them when set", () => {
    const bare = buildTuningEnvSnapshot(bareConfig());
    for (const key of [
      "EMBEDDING_TUNE_MIN_BATCH_SIZE",
      "EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE",
      "QDRANT_MAX_RESIDENT_MEMORY_PERCENT",
      "QDRANT_SEARCH_MAX_BATCHSIZE",
    ]) {
      expect(bare).not.toHaveProperty(key);
    }

    const cfg = bareConfig();
    cfg.embedding = embeddingSchema.parse({ tune: { minBatchSize: "8", maxRequestsPerMinute: "600" } });
    cfg.qdrantTune = qdrantTuneSchema.parse({ maxResidentMemoryPercent: "80", searchMaxBatchsize: "64" });
    const set = buildTuningEnvSnapshot(cfg);
    expect(set.EMBEDDING_TUNE_MIN_BATCH_SIZE).toBe("8");
    expect(set.EMBEDDING_TUNE_MAX_REQUESTS_PER_MINUTE).toBe("600");
    expect(set.QDRANT_MAX_RESIDENT_MEMORY_PERCENT).toBe("80");
    expect(set.QDRANT_SEARCH_MAX_BATCHSIZE).toBe("64");
  });

  it("reflects explicit config values, not defaults (env-tuned run persists its tuning)", () => {
    const cfg = bareConfig();
    cfg.vcs = vcsSchema.parse({ adapter: "es-git" });
    cfg.trajectoryGit = trajectoryGitSchema.parse({ chunkConcurrency: "20", enabled: "false" });
    cfg.ingest = ingestSchema.parse({ tune: { pipelineConcurrency: "8" } });
    const snapshot = buildTuningEnvSnapshot(cfg);
    expect(snapshot.GIT_ADAPTER).toBe("es-git");
    expect(snapshot.TRAJECTORY_GIT_CHUNK_CONCURRENCY).toBe("20");
    expect(snapshot.TRAJECTORY_GIT_ENABLED).toBe("false");
    expect(snapshot.INGEST_PIPELINE_CONCURRENCY).toBe("8");
  });

  it("covers EVERY canonical group key exactly when everything is set (drift guard)", () => {
    // A fully-pinned config (adaptive flags on, optionals set) must produce a
    // snapshot whose key set is exactly the canonical key set of
    // TUNING_ENV_GROUPS — a new allowlist group without a mapping here (or
    // vice versa) fails this test instead of silently dropping the key.
    const cfg = bareConfig();
    cfg.flags = {
      userSetBatchSize: true,
      userSetChunkSize: true,
      userSetDeleteBatchSize: true,
      userSetDeleteConcurrency: true,
    };
    cfg.embedding = embeddingSchema.parse({ tune: { minBatchSize: "8", maxRequestsPerMinute: "600" } });
    cfg.qdrantTune = qdrantTuneSchema.parse({ maxResidentMemoryPercent: "80", searchMaxBatchsize: "64" });
    const snapshot = buildTuningEnvSnapshot(cfg);
    const canonicals = TUNING_ENV_GROUPS.map((g) => g.canonical).sort();
    expect(Object.keys(snapshot).sort()).toEqual(canonicals);
  });

  it("emits only canonical keys — deprecated alias spellings never appear", () => {
    const snapshot = buildTuningEnvSnapshot(bareConfig());
    const aliases = new Set(TUNING_ENV_GROUPS.flatMap((g) => [...g.aliases]));
    for (const key of Object.keys(snapshot)) {
      expect(aliases.has(key)).toBe(false);
    }
  });
});
