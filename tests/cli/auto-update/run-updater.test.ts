import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTO_UPDATE_EXIT, runUpdater, type RunUpdaterDeps } from "../../../src/cli/auto-update/run-updater.js";
import {
  CollectionRegistry,
  IndexingAlreadyInProgressError,
  type CollectionEntry,
} from "../../../src/core/api/public/index.js";

const NOW = 1_700_000_000_000;

const entry: CollectionEntry = {
  collectionName: "code_abc",
  path: "/repo/a",
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-08-06T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
  autoUpdate: { enabled: true, targetBranch: "master" },
};

interface DepsOverrides {
  registry?: Partial<RunUpdaterDeps["registry"]>;
  app?: Partial<RunUpdaterDeps["app"]>;
  freshness?: RunUpdaterDeps["freshness"];
}

function deps(over: DepsOverrides = {}): RunUpdaterDeps & { recorded: () => unknown } {
  const recordAutoUpdateRun = vi.fn();
  const base: RunUpdaterDeps = {
    registry: {
      get: () => entry,
      recordAutoUpdateRun,
      ...over.registry,
    } as RunUpdaterDeps["registry"],
    app: {
      getIndexStatus: async () => ({ isIndexed: true, status: "indexed" as const }),
      indexCodebase: async () => ({
        filesScanned: 3,
        filesIndexed: 3,
        chunksCreated: 9,
        durationMs: 50,
        status: "completed" as const,
        changeDetails: {
          filesAdded: 1,
          filesModified: 2,
          filesDeleted: 0,
          filesNewlyIgnored: 0,
          filesNewlyUnignored: 0,
          chunksAdded: 9,
          chunksDeleted: 0,
        },
      }),
      whenEnrichmentComplete: async () => {},
      ...over.app,
    } as RunUpdaterDeps["app"],
    freshness: over.freshness ?? { check: () => ({ kind: "eligible", entry }) },
    clock: () => NOW,
    log: () => {},
  };
  return {
    ...base,
    recorded: () => (recordAutoUpdateRun.mock.calls.at(-1) ?? [])[1],
  };
}

describe("runUpdater", () => {
  it("skipped when the registry entry vanished (no lastRun write possible)", async () => {
    const d = deps({ registry: { get: () => null } });
    expect(await runUpdater("gone", d)).toBe(AUTO_UPDATE_EXIT.skipped);
    expect(d.recorded()).toBeUndefined();
  });

  it("skipped on TOCTOU branch mismatch, lastRun recorded", async () => {
    const d = deps({
      freshness: { check: () => ({ kind: "branch-mismatch", head: "feature-x", targetBranch: "master" }) },
    });
    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.skipped);
    expect(d.recorded()).toMatchObject({ outcome: "skipped", filesChanged: 0 });
  });

  it("lock-held when another run is indexing (live marker heartbeat)", async () => {
    const d = deps({
      app: { getIndexStatus: async () => ({ isIndexed: false, status: "indexing" as const }) },
    });
    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.lockHeld);
    expect(d.recorded()).toMatchObject({ outcome: "lock-held" });
  });

  it("ok path waits for enrichment and records durationMs + filesChanged", async () => {
    const order: string[] = [];
    const d = deps({
      app: {
        indexCodebase: async () => {
          order.push("index");
          return {
            filesScanned: 3,
            filesIndexed: 3,
            chunksCreated: 9,
            durationMs: 50,
            status: "completed" as const,
            changeDetails: {
              filesAdded: 1,
              filesModified: 2,
              filesDeleted: 0,
              filesNewlyIgnored: 0,
              filesNewlyUnignored: 0,
              chunksAdded: 9,
              chunksDeleted: 0,
            },
          };
        },
        whenEnrichmentComplete: async () => {
          order.push("enrichment");
        },
      },
    });
    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.ok);
    expect(order).toEqual(["index", "enrichment"]);
    expect(d.recorded()).toMatchObject({ outcome: "ok", filesChanged: 3 });
    expect((d.recorded() as { at: string }).at).toBe(new Date(NOW).toISOString());
  });

  it("no-op when the delta is empty", async () => {
    const d = deps({
      app: {
        indexCodebase: async () => ({
          filesScanned: 3,
          filesIndexed: 0,
          chunksCreated: 0,
          durationMs: 10,
          status: "completed" as const,
          changeDetails: {
            filesAdded: 0,
            filesModified: 0,
            filesDeleted: 0,
            filesNewlyIgnored: 0,
            filesNewlyUnignored: 0,
            chunksAdded: 0,
            chunksDeleted: 0,
          },
        }),
      },
    });
    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.ok);
    expect(d.recorded()).toMatchObject({ outcome: "no-op", filesChanged: 0 });
  });

  it("lock-held, one quiet log line, when the index call is rejected as already in progress (62pgi)", async () => {
    // The status probe above cannot see every overlap (background enrichment of
    // an incremental run leaves no indexing marker), so the run itself refuses —
    // and that refusal is the lock doing its job, not an updater failure.
    const lines: string[] = [];
    const d = deps({
      app: {
        indexCodebase: async () => {
          throw new IndexingAlreadyInProgressError("/repo/a");
        },
      },
    });
    d.log = (line) => lines.push(line);

    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.lockHeld);
    expect(d.recorded()).toMatchObject({ outcome: "lock-held", filesChanged: 0 });
    const afterStart = lines.filter((line) => !line.includes("reindexing"));
    expect(afterStart).toHaveLength(1);
    expect(afterStart[0]).toMatch(/already in progress — lock-held/);
  });

  it("failed records a trimmed error and exits 1", async () => {
    const d = deps({
      app: {
        indexCodebase: async () => {
          throw new Error(`embedding endpoint down ${"x".repeat(600)}`);
        },
      },
    });
    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.failed);
    const rec = d.recorded() as { outcome: string; error?: string };
    expect(rec.outcome).toBe("failed");
    expect(rec.error).toBeDefined();
    expect(rec.error!.length).toBeLessThanOrEqual(500);
  });
});

describe("runUpdater against a real CollectionRegistry", () => {
  // The updater holds the registry instance the CLI built BEFORE the pipeline
  // ran, so its cached entry is stale by the time lastRun is written. Writing
  // that cache back wholesale rolled the pipeline's fresh stamp away.
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "au-reg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const seed = {
    collectionName: "code_abc",
    path: "/repo/a",
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    teaRagsVersion: "1.0.0",
  };

  const indexStats = {
    filesScanned: 3,
    filesIndexed: 3,
    chunksCreated: 9,
    durationMs: 50,
    status: "completed" as const,
    changeDetails: {
      filesAdded: 1,
      filesModified: 2,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      chunksAdded: 9,
      chunksDeleted: 0,
    },
  };

  it("records lastRun without rolling back the stamp the indexing run wrote", async () => {
    const cliRegistry = new CollectionRegistry(dir);
    cliRegistry.record({ ...seed, indexedAt: "2026-09-12T11:00:00.000Z", chunksCount: 10 });
    cliRegistry.setAutoUpdate("code_abc", { enabled: true, targetBranch: "master" });
    const loaded = cliRegistry.get("code_abc")!;

    const d: RunUpdaterDeps = {
      registry: cliRegistry,
      app: {
        getIndexStatus: async () => ({ isIndexed: true, status: "indexed" as const }),
        indexCodebase: async () => {
          // The pipeline stamps through its OWN registry instance.
          const pipelineRegistry = new CollectionRegistry(dir);
          pipelineRegistry.record({
            ...seed,
            indexedAt: "2026-09-12T11:57:57.000Z",
            chunksCount: 42,
            git: { indexedBranch: "master", indexedCommit: "abc123", indexedDirty: false },
          });
          return indexStats;
        },
        whenEnrichmentComplete: async () => {},
      } as RunUpdaterDeps["app"],
      freshness: { check: () => ({ kind: "eligible", entry: loaded }) },
      clock: () => NOW,
      log: () => {},
    };

    expect(await runUpdater("code_abc", d)).toBe(AUTO_UPDATE_EXIT.ok);

    const onDisk = new CollectionRegistry(dir).get("code_abc");
    expect(onDisk?.indexedAt).toBe("2026-09-12T11:57:57.000Z");
    expect(onDisk?.chunksCount).toBe(42);
    expect(onDisk?.git).toEqual({ indexedBranch: "master", indexedCommit: "abc123", indexedDirty: false });
    expect(onDisk?.autoUpdate?.lastRun).toMatchObject({ outcome: "ok", filesChanged: 3 });
    expect(onDisk?.autoUpdate?.lastRun?.at).toBe(new Date(NOW).toISOString());
  });
});
