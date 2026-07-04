import { describe, expect, it } from "vitest";

import { replayTuningEnv } from "../../src/cli/registry-env-replay.js";

describe("replayTuningEnv", () => {
  it("fills unset target keys from the tuning snapshot (registry fills the gaps)", () => {
    const target: Record<string, string> = {};
    replayTuningEnv({ GIT_ADAPTER: "es-git", TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5" }, target);
    expect(target.GIT_ADAPTER).toBe("es-git");
    expect(target.TRAJECTORY_GIT_CHUNK_CONCURRENCY).toBe("5");
  });

  it("keeps an already-set non-empty target value (env > registry)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "git" };
    replayTuningEnv({ GIT_ADAPTER: "es-git" }, target);
    expect(target.GIT_ADAPTER).toBe("git");
  });

  it("treats an empty-string target value as unset (matching envWithFallback)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "" };
    replayTuningEnv({ GIT_ADAPTER: "es-git" }, target);
    expect(target.GIT_ADAPTER).toBe("es-git");
  });

  it("skips empty-string snapshot values (hand-edited registry) so they don't poison the env", () => {
    const target: Record<string, string> = {};
    replayTuningEnv({ GIT_ADAPTER: "" }, target);
    expect("GIT_ADAPTER" in target).toBe(false);
  });

  it("is a no-op for an undefined snapshot (legacy entry without tuning)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "git" };
    replayTuningEnv(undefined, target);
    expect(target).toEqual({ GIT_ADAPTER: "git" });
  });

  describe("alias-group awareness (env > registry must hold for deprecated spellings)", () => {
    // index-codebase seeds a FRESH env object from the registry, then merges
    // ambient process.env over it. Without group awareness a canonical registry
    // key (INGEST_PIPELINE_CONCURRENCY) survives the merge and SHADOWS an
    // externally-passed deprecated alias (EMBEDDING_CONCURRENCY) because
    // envWithFallback prefers the canonical spelling — the external override
    // silently loses. Replay must skip a snapshot key when ANY spelling of its
    // alias group is already set in the ambient env.
    it("skips a canonical snapshot key when a deprecated alias is set in the ambient env", () => {
      const target: Record<string, string> = {};
      replayTuningEnv({ INGEST_PIPELINE_CONCURRENCY: "8" }, target, { EMBEDDING_CONCURRENCY: "4" });
      expect("INGEST_PIPELINE_CONCURRENCY" in target).toBe(false);
    });

    it("skips a canonical snapshot key when a deprecated alias is set in the target itself", () => {
      // prime/tune replay directly into process.env: target IS the ambient env.
      const target: Record<string, string> = { GIT_CHUNK_CONCURRENCY: "3" };
      replayTuningEnv({ TRAJECTORY_GIT_CHUNK_CONCURRENCY: "20" }, target);
      expect("TRAJECTORY_GIT_CHUNK_CONCURRENCY" in target).toBe(false);
      expect(target.GIT_CHUNK_CONCURRENCY).toBe("3");
    });

    it("skips a legacy alias snapshot key when the canonical spelling is set in the ambient env", () => {
      // Old registry entries may still carry alias keys; a canonical external
      // override must beat them the same way.
      const target: Record<string, string> = {};
      replayTuningEnv({ EMBEDDING_CONCURRENCY: "4" }, target, { INGEST_PIPELINE_CONCURRENCY: "8" });
      expect("EMBEDDING_CONCURRENCY" in target).toBe(false);
    });

    it("a shared alias (CODE_BATCH_SIZE) set in the ambient env blocks BOTH of its groups", () => {
      const target: Record<string, string> = {};
      replayTuningEnv({ EMBEDDING_TUNE_BATCH_SIZE: "512", QDRANT_TUNE_UPSERT_BATCH_SIZE: "200" }, target, {
        CODE_BATCH_SIZE: "64",
      });
      expect("EMBEDDING_TUNE_BATCH_SIZE" in target).toBe(false);
      expect("QDRANT_TUNE_UPSERT_BATCH_SIZE" in target).toBe(false);
    });

    it("an empty-string alias in the ambient env does NOT block replay (unset semantics)", () => {
      const target: Record<string, string> = {};
      replayTuningEnv({ INGEST_PIPELINE_CONCURRENCY: "8" }, target, { EMBEDDING_CONCURRENCY: "" });
      expect(target.INGEST_PIPELINE_CONCURRENCY).toBe("8");
    });

    it("unrelated ambient keys never block replay", () => {
      const target: Record<string, string> = {};
      replayTuningEnv({ GIT_ADAPTER: "es-git" }, target, { INGEST_PIPELINE_CONCURRENCY: "8", PATH: "/usr/bin" });
      expect(target.GIT_ADAPTER).toBe("es-git");
    });

    it("a snapshot key outside every known group falls back to same-key checks only", () => {
      // Forward compat: a snapshot written by a NEWER tea-rags with a new
      // tuning var must still replay verbatim on this version.
      const target: Record<string, string> = {};
      replayTuningEnv({ FUTURE_TUNING_KNOB: "7" }, target, {});
      expect(target.FUTURE_TUNING_KNOB).toBe("7");
    });
  });
});
