/**
 * buildEffectiveIndexEnvSnapshot — the env the NEXT index run on a collection
 * would use, given the snapshot its last run stamped (bd tea-rags-mcp-lg361).
 *
 * This is the current side of the env drift axis. It has to reproduce what
 * `ProjectIngestFactory#forPath` does before an index run — outer env > stored
 * registry env > code default — or `EnvDriftMonitor` reports phantom drift for
 * every project whose registry env differs from the server's process env.
 */

import { describe, expect, it } from "vitest";

import { buildEffectiveIndexEnvSnapshot } from "../../src/bootstrap/config/env-snapshot.js";
import { EnvDriftMonitor } from "../../src/core/domains/maintenance/drift/env-drift-monitor.js";

/** A stamp in the shape `buildRegistryEnvSnapshot` writes: canonical keys only. */
const STAMP = {
  GIT_ADAPTER: "es-git",
  TRAJECTORY_GIT_ENABLED: "true",
  TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
  INGEST_ENABLE_AST: "true",
  INGEST_CHUNK_OVERLAP: "200",
  CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict",
  INGEST_TUNE_CHUNKER_POOL_SIZE: "8",
};

describe("buildEffectiveIndexEnvSnapshot", () => {
  it("replays every stamped key when the ambient env sets none of them", () => {
    const effective = buildEffectiveIndexEnvSnapshot(STAMP, {});

    for (const [key, value] of Object.entries(STAMP)) expect(effective[key], key).toBe(value);
  });

  it("lets an outer value win over the stamp — that, and only that, is drift", () => {
    const effective = buildEffectiveIndexEnvSnapshot(STAMP, { CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first" });

    expect(effective.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE).toBe("first");
    expect(effective.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS).toBe("12");
  });

  it("honours a deprecated outer spelling over the stamped canonical key", () => {
    const effective = buildEffectiveIndexEnvSnapshot(STAMP, { GIT_LOG_MAX_AGE_MONTHS: "3" });

    expect(effective.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS).toBe("3");
  });

  it("materializes code defaults for keys neither side set", () => {
    const effective = buildEffectiveIndexEnvSnapshot({}, {});

    expect(effective.GIT_ADAPTER).toBe("git");
    expect(effective.EMBEDDING_PROVIDER).toBe("ollama");
    expect(effective.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE).toBe("strict");
  });

  it("re-attaches the identity keys the registry snapshot omits", () => {
    const off = buildEffectiveIndexEnvSnapshot({}, {});
    expect(off.CODEGRAPH_ENABLED).toBe("false");
    expect(off.EMBEDDING_MODEL).toBeUndefined();

    const on = buildEffectiveIndexEnvSnapshot({ CODEGRAPH_ENABLED: "true" }, { EMBEDDING_MODEL: "mxbai-embed-large" });
    expect(on.CODEGRAPH_ENABLED).toBe("true");
    expect(on.EMBEDDING_MODEL).toBe("mxbai-embed-large");
  });

  it("never writes to the env it was handed", () => {
    const ambient: NodeJS.ProcessEnv = {};

    buildEffectiveIndexEnvSnapshot(STAMP, ambient);

    expect(ambient).toEqual({});
  });

  it("makes no claim when the stamp carries a value this build no longer accepts", () => {
    // A retired enum member is exactly what a version bump can leave behind.
    expect(buildEffectiveIndexEnvSnapshot({ GIT_ADAPTER: "nodegit" }, {})).toEqual({});
  });

  it("makes no claim when the stamped provider's secret is absent from this process", () => {
    expect(buildEffectiveIndexEnvSnapshot({ EMBEDDING_PROVIDER: "openai" }, {})).toEqual({});
  });
});

describe("buildEffectiveIndexEnvSnapshot wired into EnvDriftMonitor", () => {
  const registry = {
    get: () => ({ env: STAMP, codegraphEnabled: true, embeddingModel: "nomic-embed-text" }),
  } as never;

  const monitorWithAmbient = (ambient: NodeJS.ProcessEnv) =>
    new EnvDriftMonitor(registry, (stored) => buildEffectiveIndexEnvSnapshot(stored, ambient));

  it("reports nothing when the outer env overrides nothing", () => {
    expect(monitorWithAmbient({}).check("c")).toEqual([]);
  });

  it("reports the overridden key alone, and stays quiet about the runtime one", () => {
    const findings = monitorWithAmbient({
      CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first",
      INGEST_TUNE_CHUNKER_POOL_SIZE: "2",
    }).check("c");

    expect(findings).toEqual([
      {
        axis: "env",
        subject: "CODEGRAPH_AMBIGUOUS_RESOLVE_MODE",
        indexed: "strict",
        current: "first",
        remedy: { kind: "recompute", trajectories: new Set(["codegraph"]), languages: null },
      },
    ]);
  });

  it("attributes a codegraph flag the outer env turned off", () => {
    expect(monitorWithAmbient({ CODEGRAPH_ENABLED: "false" }).check("c")).toEqual([
      {
        axis: "env",
        subject: "CODEGRAPH_ENABLED",
        indexed: "true",
        current: "false",
        remedy: { kind: "recompute", trajectories: new Set(["codegraph"]), languages: null },
        note: "explains any codegraph.* payload-key drift — restore the flag instead of rebuilding",
      },
    ]);
  });
});
