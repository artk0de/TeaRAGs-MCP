/**
 * buildEffectiveIndexEnvSnapshot / buildRunningIndexEnvSnapshot — the two
 * "current" sides of the env drift axis (bd tea-rags-mcp-lg361).
 *
 * The effective one is what the NEXT index run on a collection would use, given
 * the snapshot its last run stamped. It has to reproduce what
 * `ProjectIngestFactory#forPath` does before an index run — outer env > stored
 * registry env > code default — or `EnvDriftMonitor` reports phantom drift for
 * every project whose registry env differs from the server's process env.
 *
 * The running one is this process's OWN resolved config, with no replay. The
 * two enable flags are compared against that instead, because replay would
 * restore a stamped flag and hide the flip the axis exists to explain.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEffectiveIndexEnvSnapshot,
  buildRunningIndexEnvSnapshot,
} from "../../src/bootstrap/config/env-snapshot.js";
import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";
import { EnvDriftMonitor } from "../../src/core/domains/maintenance/drift/env-drift-monitor.js";
import { isDebug, setDebug } from "../../src/core/infra/runtime.js";

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

const COLLECTION = "code_abc123";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildEffectiveIndexEnvSnapshot", () => {
  it("replays every stamped key when the ambient env sets none of them", () => {
    const effective = buildEffectiveIndexEnvSnapshot(STAMP, COLLECTION, {});

    for (const [key, value] of Object.entries(STAMP)) expect(effective[key], key).toBe(value);
  });

  it("lets an outer value win over the stamp — that, and only that, is drift", () => {
    const effective = buildEffectiveIndexEnvSnapshot(STAMP, COLLECTION, {
      CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first",
    });

    expect(effective.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE).toBe("first");
    expect(effective.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS).toBe("12");
  });

  it("honours a deprecated outer spelling over the stamped canonical key", () => {
    const effective = buildEffectiveIndexEnvSnapshot(STAMP, COLLECTION, { GIT_LOG_MAX_AGE_MONTHS: "3" });

    expect(effective.TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS).toBe("3");
  });

  it("materializes code defaults for keys neither side set", () => {
    const effective = buildEffectiveIndexEnvSnapshot({}, COLLECTION, {});

    expect(effective.GIT_ADAPTER).toBe("git");
    expect(effective.EMBEDDING_PROVIDER).toBe("ollama");
    expect(effective.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE).toBe("strict");
  });

  it("re-attaches the identity keys the registry snapshot omits", () => {
    const off = buildEffectiveIndexEnvSnapshot({}, COLLECTION, {});
    expect(off.CODEGRAPH_ENABLED).toBe("false");
    expect(off.EMBEDDING_MODEL).toBeUndefined();

    const on = buildEffectiveIndexEnvSnapshot({ CODEGRAPH_ENABLED: "true" }, COLLECTION, {
      EMBEDDING_MODEL: "mxbai-embed-large",
    });
    expect(on.CODEGRAPH_ENABLED).toBe("true");
    expect(on.EMBEDDING_MODEL).toBe("mxbai-embed-large");
  });

  it("never writes to the env it was handed", () => {
    const ambient: NodeJS.ProcessEnv = {};

    buildEffectiveIndexEnvSnapshot(STAMP, COLLECTION, ambient);

    expect(ambient).toEqual({});
  });

  it("reads process.env by default — the factory passes no ambient of its own", () => {
    const had = Object.hasOwn(process.env, "CODEGRAPH_AMBIGUOUS_RESOLVE_MODE");
    const previous = process.env.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE;
    try {
      process.env.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE = "first";

      // Default ambient: the outer value must beat the stamp, exactly as it
      // does in the explicit-ambient case above.
      expect(buildEffectiveIndexEnvSnapshot(STAMP, COLLECTION).CODEGRAPH_AMBIGUOUS_RESOLVE_MODE).toBe("first");
    } finally {
      if (had) process.env.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE = previous;
      else delete process.env.CODEGRAPH_AMBIGUOUS_RESOLVE_MODE;
    }
    expect(Object.hasOwn(process.env, "CODEGRAPH_AMBIGUOUS_RESOLVE_MODE")).toBe(had);
  });

  it("makes no claim when the stamp carries a value this build no longer accepts", () => {
    // A retired enum member is exactly what a version bump can leave behind.
    expect(buildEffectiveIndexEnvSnapshot({ GIT_ADAPTER: "nodegit" }, COLLECTION, {})).toEqual({});
  });

  it("makes no claim when the stamped provider's secret is absent from this process", () => {
    expect(buildEffectiveIndexEnvSnapshot({ EMBEDDING_PROVIDER: "openai" }, COLLECTION, {})).toEqual({});
  });

  it("says which collection went quiet, so a silent axis is diagnosable", () => {
    const debugWas = isDebug();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setDebug(true);
      buildEffectiveIndexEnvSnapshot({ GIT_ADAPTER: "nodegit" }, COLLECTION, {});
    } finally {
      setDebug(debugWas);
    }

    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]?.[0]).toContain(COLLECTION);
  });

  it("stays quiet outside debug", () => {
    const debugWas = isDebug();
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      setDebug(false);
      buildEffectiveIndexEnvSnapshot({ GIT_ADAPTER: "nodegit" }, COLLECTION, {});
    } finally {
      setDebug(debugWas);
    }

    expect(stderr).not.toHaveBeenCalled();
  });
});

describe("buildRunningIndexEnvSnapshot", () => {
  it("reports this process's own resolved config, with no registry replay", () => {
    const running = buildRunningIndexEnvSnapshot(parseAppConfigZod({ CODEGRAPH_ENABLED: "true" }));

    expect(running.CODEGRAPH_ENABLED).toBe("true");
    expect(running.TRAJECTORY_GIT_ENABLED).toBe("true");
  });

  it("resolves an absent flag to its code default — the prime-hook case", () => {
    expect(buildRunningIndexEnvSnapshot(parseAppConfigZod({})).CODEGRAPH_ENABLED).toBe("false");
  });
});

describe("the two current sides wired into EnvDriftMonitor", () => {
  const registry = {
    get: () => ({ env: STAMP, codegraphEnabled: true, embeddingModel: "nomic-embed-text" }),
  } as never;

  const monitorWithAmbient = (ambient: NodeJS.ProcessEnv) =>
    new EnvDriftMonitor(
      registry,
      (stored, collectionName) => buildEffectiveIndexEnvSnapshot(stored, collectionName, ambient),
      buildRunningIndexEnvSnapshot(parseAppConfigZod(ambient)),
    );

  it("reports nothing when the reading process matches the stamp", () => {
    expect(monitorWithAmbient({ CODEGRAPH_ENABLED: "true" }).check(COLLECTION)).toEqual([]);
  });

  it("reports the overridden key alone, and stays quiet about the runtime one", () => {
    const findings = monitorWithAmbient({
      CODEGRAPH_ENABLED: "true",
      CODEGRAPH_AMBIGUOUS_RESOLVE_MODE: "first",
      INGEST_TUNE_CHUNKER_POOL_SIZE: "2",
    }).check(COLLECTION);

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

  it("attributes the flag when the reading process merely LACKS it (the prime-hook phantom)", () => {
    expect(monitorWithAmbient({}).check(COLLECTION)).toEqual([
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

  it("attributes it the same way when the reading process sets it to false", () => {
    expect(monitorWithAmbient({ CODEGRAPH_ENABLED: "false" }).check(COLLECTION)).toEqual([
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
});
