import { describe, expect, it } from "vitest";

import {
  outerEnvForRegistryStamp,
  replayRegistryEnv,
} from "../../../../../src/core/domains/maintenance/registry/env-replay.js";

describe("replayRegistryEnv", () => {
  it("fills unset target keys from the tuning snapshot (registry fills the gaps)", () => {
    const target: Record<string, string> = {};
    replayRegistryEnv({ GIT_ADAPTER: "es-git", TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5" }, target);
    expect(target.GIT_ADAPTER).toBe("es-git");
    expect(target.TRAJECTORY_GIT_CHUNK_CONCURRENCY).toBe("5");
  });

  it("keeps an already-set non-empty target value (env > registry)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "git" };
    replayRegistryEnv({ GIT_ADAPTER: "es-git" }, target);
    expect(target.GIT_ADAPTER).toBe("git");
  });

  it("treats an empty-string target value as unset (matching envWithFallback)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "" };
    replayRegistryEnv({ GIT_ADAPTER: "es-git" }, target);
    expect(target.GIT_ADAPTER).toBe("es-git");
  });

  it("skips empty-string snapshot values (hand-edited registry) so they don't poison the env", () => {
    const target: Record<string, string> = {};
    replayRegistryEnv({ GIT_ADAPTER: "" }, target);
    expect("GIT_ADAPTER" in target).toBe(false);
  });

  it("is a no-op for an undefined snapshot (legacy entry without tuning)", () => {
    const target: Record<string, string> = { GIT_ADAPTER: "git" };
    replayRegistryEnv(undefined, target);
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
      replayRegistryEnv({ INGEST_PIPELINE_CONCURRENCY: "8" }, target, { EMBEDDING_CONCURRENCY: "4" });
      expect("INGEST_PIPELINE_CONCURRENCY" in target).toBe(false);
    });

    it("skips a canonical snapshot key when a deprecated alias is set in the target itself", () => {
      // prime/tune replay directly into process.env: target IS the ambient env.
      const target: Record<string, string> = { GIT_CHUNK_CONCURRENCY: "3" };
      replayRegistryEnv({ TRAJECTORY_GIT_CHUNK_CONCURRENCY: "20" }, target);
      expect("TRAJECTORY_GIT_CHUNK_CONCURRENCY" in target).toBe(false);
      expect(target.GIT_CHUNK_CONCURRENCY).toBe("3");
    });

    it("skips a legacy alias snapshot key when the canonical spelling is set in the ambient env", () => {
      // Old registry entries may still carry alias keys; a canonical external
      // override must beat them the same way.
      const target: Record<string, string> = {};
      replayRegistryEnv({ EMBEDDING_CONCURRENCY: "4" }, target, { INGEST_PIPELINE_CONCURRENCY: "8" });
      expect("EMBEDDING_CONCURRENCY" in target).toBe(false);
    });

    it("a shared alias (CODE_BATCH_SIZE) set in the ambient env blocks BOTH of its groups", () => {
      const target: Record<string, string> = {};
      replayRegistryEnv({ EMBEDDING_TUNE_BATCH_SIZE: "512", QDRANT_TUNE_UPSERT_BATCH_SIZE: "200" }, target, {
        CODE_BATCH_SIZE: "64",
      });
      expect("EMBEDDING_TUNE_BATCH_SIZE" in target).toBe(false);
      expect("QDRANT_TUNE_UPSERT_BATCH_SIZE" in target).toBe(false);
    });

    it("an empty-string alias in the ambient env does NOT block replay (unset semantics)", () => {
      const target: Record<string, string> = {};
      replayRegistryEnv({ INGEST_PIPELINE_CONCURRENCY: "8" }, target, { EMBEDDING_CONCURRENCY: "" });
      expect(target.INGEST_PIPELINE_CONCURRENCY).toBe("8");
    });

    it("unrelated ambient keys never block replay", () => {
      const target: Record<string, string> = {};
      replayRegistryEnv({ GIT_ADAPTER: "es-git" }, target, { INGEST_PIPELINE_CONCURRENCY: "8", PATH: "/usr/bin" });
      expect(target.GIT_ADAPTER).toBe("es-git");
    });

    it("an external OLLAMA_URL beats the registry canonical EMBEDDING_BASE_URL (identity keys, same rule)", () => {
      // Identity keys replay through the SAME group-aware path — the general
      // rule (outer env > registry env > code default) holds uniformly.
      const target: Record<string, string> = {};
      replayRegistryEnv({ EMBEDDING_BASE_URL: "http://remote:11434" }, target, {
        OLLAMA_URL: "http://laptop:11434",
      });
      expect("EMBEDDING_BASE_URL" in target).toBe(false);
    });

    it("a snapshot key outside every known group falls back to same-key checks only", () => {
      // Forward compat: a snapshot written by a NEWER tea-rags with a new
      // env var must still replay verbatim on this version.
      const target: Record<string, string> = {};
      replayRegistryEnv({ FUTURE_ENV_KNOB: "7" }, target, {});
      expect(target.FUTURE_ENV_KNOB).toBe("7");
    });
  });
});

describe("outerEnvForRegistryStamp", () => {
  // A long-lived MCP server's spawn env is configured once for every project it
  // serves — the tea-rags-mcp session sets CODE_CHUNK_SIZE=2000 for its OWN
  // index — so it must not re-shape a project whose stamp says otherwise
  // (tea-rags-mcp-o0qsw). A CLI invocation's env is still a deliberate override.
  const STAMP = {
    INGEST_CHUNK_SIZE: "4500",
    TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS: "false",
    INGEST_TUNE_CHUNKER_POOL_SIZE: "4",
  };
  const SERVER_ENV = {
    CODE_CHUNK_SIZE: "2000",
    TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS: "true",
    INGEST_TUNE_CHUNKER_POOL_SIZE: "8",
    DEBUG: "1",
  };

  it("hands an invocation env back whole — a CLI run's env overrides every group", () => {
    expect(outerEnvForRegistryStamp(STAMP, SERVER_ENV, "invocation")).toEqual(SERVER_ENV);
  });

  it("drops every spelling of an index-shaping group a server env sets differently from the stamp", () => {
    expect(outerEnvForRegistryStamp(STAMP, SERVER_ENV, "server")).toEqual({
      INGEST_TUNE_CHUNKER_POOL_SIZE: "8",
      DEBUG: "1",
    });
  });

  it("keeps a server's runtime groups — they decide how a run executes, never what it writes", () => {
    expect(outerEnvForRegistryStamp(STAMP, SERVER_ENV, "server").INGEST_TUNE_CHUNKER_POOL_SIZE).toBe("8");
  });

  it("keeps an index-shaping value the server env shares with the stamp — the process facade stays reusable", () => {
    expect(outerEnvForRegistryStamp({ INGEST_CHUNK_SIZE: "2000" }, SERVER_ENV, "server").CODE_CHUNK_SIZE).toBe("2000");
  });

  it("keeps an index-shaping group the stamp does not pin — there is nothing to stay consistent with", () => {
    expect(outerEnvForRegistryStamp({}, SERVER_ENV, "server").CODE_CHUNK_SIZE).toBe("2000");
  });

  it("reads a legacy deprecated spelling in the stamp as its whole group", () => {
    const outer = outerEnvForRegistryStamp({ CODE_CHUNK_OVERLAP: "300" }, { INGEST_CHUNK_OVERLAP: "450" }, "server");

    expect(outer.INGEST_CHUNK_OVERLAP).toBeUndefined();
  });

  it("treats the two enable flags like any other enrichment group — the project's stamp owns what its index carries", () => {
    const outer = outerEnvForRegistryStamp({ CODEGRAPH_ENABLED: "true" }, { CODEGRAPH_ENABLED: "false" }, "server");

    expect(outer.CODEGRAPH_ENABLED).toBeUndefined();
  });

  it("never writes to the env it was handed", () => {
    const ambient = { ...SERVER_ENV };

    outerEnvForRegistryStamp(STAMP, ambient, "server");

    expect(ambient).toEqual(SERVER_ENV);
  });

  it("hands a server env back as the same object when it overrides nothing — a caller can tell nothing was dropped", () => {
    expect(outerEnvForRegistryStamp({ INGEST_CHUNK_SIZE: "2000" }, SERVER_ENV, "server")).toBe(SERVER_ENV);
  });
});
