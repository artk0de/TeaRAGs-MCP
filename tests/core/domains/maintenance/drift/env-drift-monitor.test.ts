/**
 * EnvDriftMonitor (bd tea-rags-mcp-lg361).
 *
 * The indexing-env axis. It diffs the env stamp a run recorded against the env
 * the NEXT run on that collection would use — outer env > stored registry env >
 * code default, the replay `ProjectIngestFactory` performs (spec decision 6) —
 * so a finding means the outer env EXPLICITLY overrides a stamped value. A
 * changed code default is not drift: replay keeps the stamped value.
 *
 * The consequence class on each `REGISTRY_ENV_GROUPS` entry decides both
 * whether a key can drift at all (`runtime` cannot) and which remedy the
 * finding carries.
 */

import { describe, expect, it } from "vitest";

import { EnvDriftMonitor } from "../../../../../src/core/domains/maintenance/drift/env-drift-monitor.js";

function registryWith(env: Record<string, string>) {
  return { get: () => ({ env }) } as never;
}

describe("EnvDriftMonitor", () => {
  it("reports a value change whose consequence is not runtime, with the matching remedy", () => {
    const monitor = new EnvDriftMonitor(
      registryWith({
        TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
        INGEST_TUNE_CHUNKER_POOL_SIZE: "8",
      }),
      () => ({
        TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "6",
        INGEST_TUNE_CHUNKER_POOL_SIZE: "4",
      }),
    );

    expect(monitor.check("c")).toEqual([
      {
        axis: "env",
        subject: "TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS",
        indexed: "12",
        current: "6",
        remedy: { kind: "recompute", trajectories: new Set(["git"]), languages: null },
      },
    ]);
  });

  it("routes a chunk-set key to the full reindex", () => {
    const monitor = new EnvDriftMonitor(registryWith({ INGEST_CHUNK_OVERLAP: "200" }), () => ({
      INGEST_CHUNK_OVERLAP: "400",
    }));

    expect(monitor.check("c")).toEqual([
      {
        axis: "env",
        subject: "INGEST_CHUNK_OVERLAP",
        indexed: "200",
        current: "400",
        remedy: { kind: "force" },
      },
    ]);
  });

  it("attributes a flag flip to the payload keys it explains", () => {
    const [finding] = new EnvDriftMonitor(registryWith({ CODEGRAPH_ENABLED: "true" }), () => ({
      CODEGRAPH_ENABLED: "false",
    })).check("c");

    expect(finding.note).toBe("explains any codegraph.* payload-key drift — restore the flag instead of rebuilding");
    expect(finding.remedy).toEqual({
      kind: "recompute",
      trajectories: new Set(["codegraph"]),
      languages: null,
    });
  });

  it("attributes the git flag the same way", () => {
    const [finding] = new EnvDriftMonitor(registryWith({ TRAJECTORY_GIT_ENABLED: "true" }), () => ({
      TRAJECTORY_GIT_ENABLED: "false",
    })).check("c");

    expect(finding.note).toBe("explains any git.* payload-key drift — restore the flag instead of rebuilding");
  });

  it("stays silent for keys present on one side only, and for legacy entries without a snapshot", () => {
    expect(new EnvDriftMonitor(registryWith({ INGEST_CHUNK_SIZE: "2000" }), () => ({})).check("c")).toEqual([]);
    expect(new EnvDriftMonitor({ get: () => ({}) } as never, () => ({ INGEST_CHUNK_SIZE: "2000" })).check("c")).toEqual(
      [],
    );
    expect(new EnvDriftMonitor({ get: () => null } as never, () => ({ INGEST_CHUNK_SIZE: "2000" })).check("c")).toEqual(
      [],
    );
  });

  it("sees no drift when the effective env is the replayed stamp (no outer override)", () => {
    const stored = { INGEST_CHUNK_SIZE: "2000", CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict" };

    expect(new EnvDriftMonitor(registryWith(stored), (s) => s).check("c")).toEqual([]);
  });

  it("ignores a key outside every known group — an unclassified spelling carries no consequence", () => {
    expect(
      new EnvDriftMonitor(registryWith({ SOME_FUTURE_KNOB: "a" }), () => ({ SOME_FUTURE_KNOB: "b" })).check("c"),
    ).toEqual([]);
  });

  it("reads the legacy `tuning` map when the entry predates the env snapshot", () => {
    const monitor = new EnvDriftMonitor(
      { get: () => ({ tuning: { CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict" } }) } as never,
      () => ({ CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first" }),
    );

    expect(monitor.check("c")).toEqual([
      {
        axis: "env",
        subject: "CODEGRAPH_AMBIGUOUS_RESOLVE_MODE",
        indexed: "strict",
        current: "first",
        remedy: { kind: "recompute", trajectories: new Set(["codegraph"]), languages: null },
      },
    ]);
  });

  describe("identity keys stored in dedicated CollectionEntry fields", () => {
    /**
     * `buildRegistryEnvSnapshot` never writes a DEDICATED_FIELD_ENV_KEY into
     * `entry.env`, so composing them back is what makes a CODEGRAPH_ENABLED
     * flip visible at all — exactly the composition `resolveRegistryEnv`
     * performs before replay.
     */
    it("composes CODEGRAPH_ENABLED out of the dedicated field, so its flip is reported", () => {
      const monitor = new EnvDriftMonitor({ get: () => ({ env: {}, codegraphEnabled: true }) } as never, () => ({
        CODEGRAPH_ENABLED: "false",
      }));

      expect(monitor.check("c")).toEqual([
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

    it("composes EMBEDDING_MODEL out of the dedicated field", () => {
      const monitor = new EnvDriftMonitor(
        { get: () => ({ env: {}, embeddingModel: "nomic-embed-text" }) } as never,
        () => ({ EMBEDDING_MODEL: "mxbai-embed-large" }),
      );

      expect(monitor.check("c")).toEqual([
        {
          axis: "env",
          subject: "EMBEDDING_MODEL",
          indexed: "nomic-embed-text",
          current: "mxbai-embed-large",
          remedy: { kind: "force" },
        },
      ]);
    });

    it("carries no claim when codegraph was off at index time — the registry records only the enabled flag", () => {
      const monitor = new EnvDriftMonitor({ get: () => ({ env: {}, codegraphEnabled: false }) } as never, () => ({
        CODEGRAPH_ENABLED: "true",
      }));

      expect(monitor.check("c")).toEqual([]);
    });
  });
});
