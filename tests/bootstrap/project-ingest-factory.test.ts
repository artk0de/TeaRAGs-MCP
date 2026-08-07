/**
 * ProjectIngestFactory — per-request registry env for an index run.
 *
 * The MCP server is long-lived with a fixed process env, so a project's
 * recorded tuning can only reach its index run through the facade the run is
 * handed. These tests pin that the resolution happens per path, that ambient
 * env still wins, and — the load-bearing one — that it is done WITHOUT touching
 * process.env, so two projects indexing concurrently cannot clobber each other
 * (tea-rags-mcp-pmfm4).
 */

import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectIngestFactory } from "../../src/bootstrap/project-ingest-factory.js";
import type { CollectionEntry } from "../../src/core/contracts/types/registry.js";

function entry(over: Partial<CollectionEntry>): CollectionEntry {
  return {
    collectionName: "code_x",
    path: "/repo",
    name: null,
    embeddingModel: "jina-v2",
    embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-06-01T00:00:00Z",
    teaRagsVersion: "1.31.1",
    chunksCount: 10,
    ...over,
  };
}

interface FakeRegistry {
  findByName: (n: string) => CollectionEntry | null;
  findByPath: (p: string) => CollectionEntry | null;
  list: () => CollectionEntry[];
}

/** Registry serving one entry per path, with no cross-path fallback. */
function registryOf(entries: CollectionEntry[]): FakeRegistry {
  return {
    findByName: (n) => entries.find((e) => e.name === n) ?? null,
    findByPath: (p) => entries.find((e) => e.path === p) ?? null,
    list: () => entries,
  };
}

/** Marker facade — identity is all these tests assert on. */
const facade = (id: string): { id: string } => ({ id });

describe("ProjectIngestFactory", () => {
  it("builds the ingest facade from the target project's registry env", () => {
    const seen: Record<string, string>[] = [];
    const factory = new ProjectIngestFactory({
      registry: registryOf([entry({ path: "/repo/alpha", env: { INGEST_CHUNK_OVERLAP: "450" } })]),
      processIngest: facade("process") as never,
      buildIngest: (env) => {
        seen.push(env);
        return facade("alpha") as never;
      },
      ambientEnv: { INGEST_PIPELINE_CONCURRENCY: "2" },
    });

    const resolved = factory.forPath("/repo/alpha");

    expect(resolved).toEqual(facade("alpha"));
    expect(seen).toHaveLength(1);
    expect(seen[0].INGEST_CHUNK_OVERLAP).toBe("450");
  });

  it("reuses the process-wide facade when the registry has no entry for the path", () => {
    let built = 0;
    const factory = new ProjectIngestFactory({
      registry: registryOf([]),
      processIngest: facade("process") as never,
      buildIngest: () => {
        built += 1;
        return facade("scoped") as never;
      },
      ambientEnv: {},
    });

    expect(factory.forPath("/repo/unknown")).toEqual(facade("process"));
    expect(built).toBe(0);
  });

  it("reuses the process-wide facade when the ambient env already carries every registered value", () => {
    // The CLI worker's situation: its env was seeded from the registry before
    // the fork, so replay has nothing left to contribute and the run must stay
    // on the single composition-root facade.
    let built = 0;
    const factory = new ProjectIngestFactory({
      registry: registryOf([entry({ path: "/repo/alpha", env: { INGEST_CHUNK_OVERLAP: "450" } })]),
      processIngest: facade("process") as never,
      buildIngest: () => {
        built += 1;
        return facade("scoped") as never;
      },
      ambientEnv: {
        INGEST_CHUNK_OVERLAP: "450",
        EMBEDDING_MODEL: "jina-v2",
        QDRANT_URL: "http://127.0.0.1:6333",
      },
    });

    expect(factory.forPath("/repo/alpha")).toEqual(facade("process"));
    expect(built).toBe(0);
  });

  it("lets the ambient env override the registered value, matching CLI precedence", () => {
    const seen: Record<string, string>[] = [];
    const factory = new ProjectIngestFactory({
      registry: registryOf([
        entry({ path: "/repo/alpha", env: { INGEST_CHUNK_OVERLAP: "450", INGEST_PIPELINE_CONCURRENCY: "6" } }),
      ]),
      processIngest: facade("process") as never,
      buildIngest: (env) => {
        seen.push(env);
        return facade("alpha") as never;
      },
      ambientEnv: { INGEST_CHUNK_OVERLAP: "300" },
    });

    factory.forPath("/repo/alpha");

    expect(seen[0].INGEST_CHUNK_OVERLAP).toBe("300");
    expect(seen[0].INGEST_PIPELINE_CONCURRENCY).toBe("6");
  });

  it("hands back-to-back runs of one project the same facade", () => {
    // The facade owns the run state a repeat index depends on — the enrichment
    // coordinator, its background settle promise, the stats-refresh hook. A
    // fresh one per request would strand the previous run's enrichment.
    let built = 0;
    const factory = new ProjectIngestFactory({
      registry: registryOf([entry({ path: "/repo/alpha", env: { INGEST_CHUNK_OVERLAP: "450" } })]),
      processIngest: facade("process") as never,
      buildIngest: () => {
        built += 1;
        return facade(`scoped-${built}`) as never;
      },
      ambientEnv: {},
    });

    const first = factory.forPath("/repo/alpha");
    const second = factory.forPath("/repo/alpha");

    expect(second).toBe(first);
    expect(built).toBe(1);
  });

  it("gives projects with different registered env their own facade", () => {
    const factory = new ProjectIngestFactory({
      registry: registryOf([
        entry({ path: "/repo/alpha", env: { INGEST_CHUNK_OVERLAP: "450" } }),
        entry({ path: "/repo/beta", env: { INGEST_CHUNK_OVERLAP: "300" } }),
      ]),
      processIngest: facade("process") as never,
      buildIngest: (env) => facade(`scoped-${env.INGEST_CHUNK_OVERLAP}`) as never,
      ambientEnv: {},
    });

    expect(factory.forPath("/repo/alpha")).toEqual(facade("scoped-450"));
    expect(factory.forPath("/repo/beta")).toEqual(facade("scoped-300"));
  });

  it("keeps two overlapping index runs on different projects from clobbering each other", async () => {
    // The failure this pins: applying per-project env by writing process.env
    // for the duration of a run. Both runs are held open at the same time, so a
    // process-global write would leak into the other run and into the server
    // process itself. Each run therefore re-reads its overlap AFTER the
    // interleave, and both sample process.env while the other run is live.
    const overlapAtEnd: Record<string, string | undefined> = {};
    const processEnvDuringRun: Record<string, string | undefined> = {};
    let releaseBoth: () => void = () => {};
    const bothStarted = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });

    const factory = new ProjectIngestFactory({
      registry: registryOf([
        entry({ path: "/repo/alpha", env: { INGEST_CHUNK_OVERLAP: "450", INGEST_PIPELINE_CONCURRENCY: "6" } }),
        entry({ path: "/repo/beta", env: { INGEST_CHUNK_OVERLAP: "300", INGEST_PIPELINE_CONCURRENCY: "2" } }),
      ]),
      processIngest: facade("process") as never,
      buildIngest: (env) =>
        ({
          indexCodebase: async (target: string) => {
            await bothStarted;
            overlapAtEnd[target] = env.INGEST_CHUNK_OVERLAP;
            processEnvDuringRun[target] = process.env.INGEST_CHUNK_OVERLAP;
          },
        }) as never,
      ambientEnv: {},
    });

    const runs = Promise.all([
      (factory.forPath("/repo/alpha") as unknown as { indexCodebase: (p: string) => Promise<void> }).indexCodebase(
        "/repo/alpha",
      ),
      (factory.forPath("/repo/beta") as unknown as { indexCodebase: (p: string) => Promise<void> }).indexCodebase(
        "/repo/beta",
      ),
    ]);
    releaseBoth();
    await runs;

    expect(overlapAtEnd["/repo/alpha"]).toBe("450");
    expect(overlapAtEnd["/repo/beta"]).toBe("300");
    expect(processEnvDuringRun["/repo/alpha"]).toBeUndefined();
    expect(processEnvDuringRun["/repo/beta"]).toBeUndefined();
    expect(process.env.INGEST_CHUNK_OVERLAP).toBeUndefined();
  });
});

describe("ProjectIngestFactory path addressing", () => {
  // The registry stores the path the pipeline resolved (`realpath(resolve(p))`),
  // while an MCP caller may address the same project by a symlink, a relative
  // path or a trailing slash. Matching on the raw string would miss the entry
  // and fall through to "most recently indexed project" — quietly running the
  // project under a DIFFERENT project's tuning.
  let realDir: string;
  let linkDir: string;

  beforeAll(() => {
    realDir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pif-real-")));
    linkDir = join(realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "pif-link-"))), "alias");
    symlinkSync(realDir, linkDir, "dir");
  });

  afterAll(() => {
    rmSync(linkDir, { force: true });
    rmSync(realDir, { recursive: true, force: true });
  });

  function factoryFor(target: string): { overlapUsed: () => string | undefined } {
    let used: string | undefined;
    const factory = new ProjectIngestFactory({
      registry: registryOf([
        entry({ path: realDir, env: { INGEST_CHUNK_OVERLAP: "450" }, indexedAt: "2026-01-01T00:00:00Z" }),
        entry({ path: "/repo/unrelated", env: { INGEST_CHUNK_OVERLAP: "300" }, indexedAt: "2026-06-20T00:00:00Z" }),
      ]),
      processIngest: facade("process") as never,
      buildIngest: (env) => {
        used = env.INGEST_CHUNK_OVERLAP;
        return facade("scoped") as never;
      },
      ambientEnv: {},
    });
    factory.forPath(target);
    return { overlapUsed: () => used };
  }

  it("matches the entry when the project is addressed through a symlink", () => {
    expect(factoryFor(linkDir).overlapUsed()).toBe("450");
  });

  it("matches the entry when the project is addressed with a trailing slash", () => {
    expect(factoryFor(`${realDir}/`).overlapUsed()).toBe("450");
  });
});
