/**
 * EnvDriftMonitor (bd tea-rags-mcp-lg361).
 *
 * The indexing-env axis. It diffs the env stamp a run recorded against the env
 * the NEXT run on that collection would use — outer env > stored registry env >
 * code default, the replay `ProjectIngestFactory` performs (spec decision 6) —
 * so a finding means the outer env EXPLICITLY overrides a stamped value. A
 * changed code default is not drift: replay keeps the stamped value.
 *
 * The two ENABLE FLAGS are the ruled exception (fix round 1): they are compared
 * against the RUNNING composition instead, because replay would restore the
 * stamped flag and hide exactly the case the axis exists to explain.
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

/** No enable flag resolved by the running composition — the non-flag cases. */
const NO_RUNNING_FLAGS: Record<string, string> = {};

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
      NO_RUNNING_FLAGS,
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
    const monitor = new EnvDriftMonitor(
      registryWith({ INGEST_CHUNK_OVERLAP: "200" }),
      () => ({ INGEST_CHUNK_OVERLAP: "400" }),
      NO_RUNNING_FLAGS,
    );

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

  it("stays silent for keys present on one side only, and for legacy entries without a snapshot", () => {
    expect(
      new EnvDriftMonitor(registryWith({ INGEST_CHUNK_SIZE: "2000" }), () => ({}), NO_RUNNING_FLAGS).check("c"),
    ).toEqual([]);
    expect(
      new EnvDriftMonitor({ get: () => ({}) } as never, () => ({ INGEST_CHUNK_SIZE: "2000" }), NO_RUNNING_FLAGS).check(
        "c",
      ),
    ).toEqual([]);
    expect(
      new EnvDriftMonitor({ get: () => null } as never, () => ({ INGEST_CHUNK_SIZE: "2000" }), NO_RUNNING_FLAGS).check(
        "c",
      ),
    ).toEqual([]);
  });

  it("sees no drift when the effective env is the replayed stamp (no outer override)", () => {
    const stored = { INGEST_CHUNK_SIZE: "2000", CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict" };

    expect(new EnvDriftMonitor(registryWith(stored), (s) => s, NO_RUNNING_FLAGS).check("c")).toEqual([]);
  });

  it("ignores a key outside every known group — an unclassified spelling carries no consequence", () => {
    expect(
      new EnvDriftMonitor(
        registryWith({ SOME_FUTURE_KNOB: "a" }),
        () => ({ SOME_FUTURE_KNOB: "b" }),
        NO_RUNNING_FLAGS,
      ).check("c"),
    ).toEqual([]);
  });

  it("reads the legacy `tuning` map when the entry predates the env snapshot", () => {
    const monitor = new EnvDriftMonitor(
      { get: () => ({ tuning: { CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict" } }) } as never,
      () => ({ CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first" }),
      NO_RUNNING_FLAGS,
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

  it("hands the collection name to the effective-env resolver, so a failure can name it", () => {
    const seen: string[] = [];

    new EnvDriftMonitor(
      registryWith({ INGEST_CHUNK_SIZE: "2000" }),
      (_stored, collectionName) => {
        seen.push(collectionName);
        return {};
      },
      NO_RUNNING_FLAGS,
    ).check("code_abc123");

    expect(seen).toEqual(["code_abc123"]);
  });

  /**
   * Fix round 1, controller ruling amending spec decision 6 for these two keys
   * only. Replay RESTORES a stamped flag whenever the ambient env merely lacks
   * it, so the effective env always agrees with the stamp and the flip is
   * invisible there. Meanwhile the reading process's composition — built from
   * its own config, with no replay — declares no `codegraph.*` descriptors, and
   * the payload-key axis reports the whole family removed. Comparing against
   * the RUNNING config is what lets this axis name the cause.
   */
  describe("the two enable flags, compared against the running composition", () => {
    const storedWithCodegraph = registryWith({ CODEGRAPH_ENABLED: "true" });

    it("attributes a flag flip to the payload keys it explains, with no rebuild to run", () => {
      const [finding] = new EnvDriftMonitor(storedWithCodegraph, () => ({ CODEGRAPH_ENABLED: "true" }), {
        CODEGRAPH_ENABLED: "false",
      }).check("c");

      expect(finding.note).toBe("explains any codegraph.* payload-key drift — restore the flag instead of rebuilding");
      expect(finding.remedy).toEqual({ kind: "none" });
    });

    it("fires when the reading process merely LACKS the flag — replay would otherwise hide it", () => {
      // The effective env says "true": replay restored the stamp because the
      // ambient env sets nothing. The running composition still says "false".
      expect(
        new EnvDriftMonitor(storedWithCodegraph, () => ({ CODEGRAPH_ENABLED: "true" }), {
          CODEGRAPH_ENABLED: "false",
        }).check("c"),
      ).toEqual([
        {
          axis: "env",
          subject: "CODEGRAPH_ENABLED",
          indexed: "true",
          current: "false",
          remedy: { kind: "none" },
          note: "explains any codegraph.* payload-key drift — restore the flag instead of rebuilding",
        },
      ]);
    });

    it("fires the same way when the reading process sets the flag to false outright", () => {
      const findings = new EnvDriftMonitor(storedWithCodegraph, () => ({ CODEGRAPH_ENABLED: "false" }), {
        CODEGRAPH_ENABLED: "false",
      }).check("c");

      expect(findings.map((f) => [f.subject, f.current, f.remedy])).toEqual([
        ["CODEGRAPH_ENABLED", "false", { kind: "none" }],
      ]);
    });

    it("stays silent when the running composition agrees with the stamp", () => {
      expect(
        new EnvDriftMonitor(storedWithCodegraph, () => ({ CODEGRAPH_ENABLED: "true" }), {
          CODEGRAPH_ENABLED: "true",
        }).check("c"),
      ).toEqual([]);
    });

    it("attributes the git flag the same way", () => {
      const [finding] = new EnvDriftMonitor(
        registryWith({ TRAJECTORY_GIT_ENABLED: "true" }),
        () => ({ TRAJECTORY_GIT_ENABLED: "true" }),
        { TRAJECTORY_GIT_ENABLED: "false" },
      ).check("c");

      expect(finding.note).toBe("explains any git.* payload-key drift — restore the flag instead of rebuilding");
      expect(finding.remedy).toEqual({ kind: "none" });
    });

    it("makes no claim when the running composition does not resolve the flag at all", () => {
      expect(new EnvDriftMonitor(storedWithCodegraph, () => ({ CODEGRAPH_ENABLED: "false" }), {}).check("c")).toEqual(
        [],
      );
    });

    it("leaves every other non-runtime key on the effective-env compare", () => {
      // The running snapshot disagrees with the stamp on a NON-flag key; that
      // side is not consulted for it, so nothing is reported.
      expect(
        new EnvDriftMonitor(
          registryWith({ CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict" }),
          () => ({ CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "strict" }),
          { CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first" },
        ).check("c"),
      ).toEqual([]);
    });
  });

  describe("identity keys stored in dedicated CollectionEntry fields", () => {
    /**
     * `buildRegistryEnvSnapshot` never writes a DEDICATED_FIELD_ENV_KEY into
     * `entry.env`, so composing them back is what makes a CODEGRAPH_ENABLED
     * flip visible at all — exactly the composition `resolveRegistryEnv`
     * performs before replay.
     */
    it("composes CODEGRAPH_ENABLED out of the dedicated field, so its flip is reported", () => {
      const monitor = new EnvDriftMonitor(
        { get: () => ({ env: {}, codegraphEnabled: true }) } as never,
        () => ({ CODEGRAPH_ENABLED: "true" }),
        { CODEGRAPH_ENABLED: "false" },
      );

      expect(monitor.check("c")).toEqual([
        {
          axis: "env",
          subject: "CODEGRAPH_ENABLED",
          indexed: "true",
          current: "false",
          remedy: { kind: "none" },
          note: "explains any codegraph.* payload-key drift — restore the flag instead of rebuilding",
        },
      ]);
    });

    it("composes EMBEDDING_MODEL out of the dedicated field", () => {
      const monitor = new EnvDriftMonitor(
        { get: () => ({ env: {}, embeddingModel: "nomic-embed-text" }) } as never,
        () => ({ EMBEDDING_MODEL: "mxbai-embed-large" }),
        NO_RUNNING_FLAGS,
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
      const monitor = new EnvDriftMonitor(
        { get: () => ({ env: {}, codegraphEnabled: false }) } as never,
        () => ({ CODEGRAPH_ENABLED: "true" }),
        { CODEGRAPH_ENABLED: "true" },
      );

      expect(monitor.check("c")).toEqual([]);
    });
  });
});
