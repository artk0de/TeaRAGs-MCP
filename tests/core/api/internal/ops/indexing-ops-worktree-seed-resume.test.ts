/**
 * A seeded first index survives the death of the process that seeded it
 * (bd tea-rags-mcp-k8gac, follow-up C8).
 *
 * The seed owes two things after its incremental run: the language-version
 * stamp (an incremental never stamps, and an unstamped collection reports
 * drift that steers the user to `--force`, throwing the seed's saving away),
 * and the git rebuild (cloned points carry the SIBLING's git signals and its
 * `enrichedAt`, so recovery never re-enriches them). Both used to live only in
 * the seeding process. The seed now records `worktreeSeedPending` on the
 * collection's indexing marker right after the clone and clears it only once
 * the stamp AND the git rebuild are done; any later run that finds it resumes
 * both. Each kill point is injected by a step that never settles, and a second
 * `IndexingOps` over the same stores plays the next process.
 */

import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type {
  WorktreeSeedAttempt,
  WorktreeSeedRequest,
} from "../../../../../src/core/api/internal/ops/worktree-seed-ops.js";
import { INDEXING_METADATA_ID } from "../../../../../src/core/contracts/constants.js";
import type { LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const TARGET = resolve("/repo/wt");
const SIBLING = resolve("/repo/main");

const changeStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 1,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 2,
  chunksDeleted: 2,
  durationMs: 5,
  status: "completed",
  enrichmentStatus: "background",
};

const SEED_BUILD = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 }],
]);
const SEED_STAMP = { typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 } };

const SEEDED: WorktreeSeedAttempt = {
  status: "seeded",
  source: { collectionName: "code_main", project: "main", path: SIBLING },
  sourceFiles: 10,
  rejected: [],
};

const never = async (): Promise<never> => new Promise<never>(() => undefined);

/** An upgraded build: same chunk set, a newer walker — what a codegraph recompute stamps. */
const UPGRADED_BUILD = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 1, walker: 3, codegraphSchema: 1 }],
]);
const UPGRADED_STAMP = { typescript: { grammar: "0.23.2", chunking: 1, walker: 3, codegraphSchema: 1 } };

/** What outlives a process: Qdrant (collections + the marker point) and the registry. */
function sharedStores() {
  const collections = new Set<string>();
  const markers = new Map<string, Record<string, unknown>>();
  /** The registry's stamp per collection, merged per language AND per axis like `CollectionRegistry#stampLanguageVersions`. */
  const registry = new Map<string, Record<string, Partial<LanguageCodeVersions>>>();
  const stampLanguageVersions = vi.fn((name: string, stamp: Record<string, Partial<LanguageCodeVersions>>) => {
    const merged = { ...registry.get(name) };
    for (const [language, versions] of Object.entries(stamp)) merged[language] = { ...merged[language], ...versions };
    registry.set(name, merged);
  });
  const qdrant = {
    isEmbedded: true,
    url: "http://127.0.0.1:6333",
    collectionExists: vi.fn(async (name: string) => collections.has(name)),
    aliases: {
      listAliases: vi.fn(async () => [...collections].map((a) => ({ aliasName: a, collectionName: `${a}_v1` }))),
    },
    listCollections: vi.fn(async () => []),
    getPoint: vi.fn(async (name: string, id: string | number) => {
      const payload = id === INDEXING_METADATA_ID ? markers.get(name) : undefined;
      return payload ? { id, payload } : null;
    }),
    setPayload: vi.fn(async (name: string, payload: Record<string, unknown>, options: { points?: unknown[] }) => {
      if (!options.points?.includes(INDEXING_METADATA_ID)) return;
      markers.set(name, { ...markers.get(name), ...payload });
    }),
    batchDeletePayload: vi.fn(async (name: string, ops: { keys: string[]; points: unknown[] }[]) => {
      for (const op of ops) {
        if (!op.points.includes(INDEXING_METADATA_ID)) continue;
        const marker = { ...markers.get(name) };
        for (const key of op.keys) delete marker[key];
        markers.set(name, marker);
      }
    }),
  };
  /**
   * The seed clones the sibling's footprint — its completed marker included —
   * and, like the real Qdrant clone, records the debt the run handed it on the
   * clone's marker before the collection becomes visible.
   */
  const cloneSibling = (request: WorktreeSeedRequest): void => {
    collections.add("code_wt");
    markers.set("code_wt", {
      indexingComplete: true,
      completedAt: "2026-09-01T00:00:00Z",
      worktreeSeedPending: request.pending,
    });
  };
  const seed = vi.fn(async (request: WorktreeSeedRequest) => {
    cloneSibling(request);
    return Promise.resolve(SEEDED);
  });
  return { collections, markers, registry, stampLanguageVersions, qdrant, seed, cloneSibling };
}

type Stores = ReturnType<typeof sharedStores>;

/** One process: its own IndexingOps over the shared stores. */
function processOver(
  stores: Stores,
  steps: {
    reindexChanges?: () => Promise<ChangeStats>;
    recomputeEnrichments?: () => Promise<unknown>;
    languageCodeVersions?: ReadonlyMap<string, LanguageCodeVersions>;
  } = {},
) {
  const deps: IndexingOpsDeps = {
    qdrant: stores.qdrant as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      getModel: vi.fn(() => "nomic"),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn().mockResolvedValue({ status: "completed", filesIndexed: 7 }) } as never,
    reindex: { reindexChanges: vi.fn(steps.reindexChanges ?? (async () => Promise.resolve(changeStats))) } as never,
    enrichment: {
      providerKeys: ["git", "codegraph"],
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn(steps.recomputeEnrichments ?? (async () => Promise.resolve(undefined))),
    } as never,
    snapshotDir: "/tmp/snap",
    allPayloadSignals: [],
    languageCodeVersions: steps.languageCodeVersions ?? SEED_BUILD,
    collectionRegistry: { stampLanguageVersions: stores.stampLanguageVersions },
    driftReporter: { reset: vi.fn() },
    resolveCollectionForPath: async (path) => Promise.resolve(path === SIBLING ? "code_main" : "code_wt"),
    envSnapshot: { INGEST_CHUNK_SIZE: "2500" },
    worktreeSeed: { seed: stores.seed },
  };
  return { ops: new IndexingOps(deps), deps };
}

describe("IndexingOps — a seed left pending by a dead process is resumed", () => {
  it("records the pending seed on the collection's marker before the seeded incremental starts", async () => {
    const stores = sharedStores();
    const first = processOver(stores, { reindexChanges: never });

    void first.ops.run(TARGET);
    await vi.waitFor(() => {
      expect(first.deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    });

    expect(stores.markers.get("code_wt")?.worktreeSeedPending).toMatchObject({ languageVersions: SEED_STAMP });
    expect(stores.stampLanguageVersions).not.toHaveBeenCalled();
  });

  it("killed inside the seed, once the clone is visible: the next run finds the pending seed and settles it", async () => {
    const stores = sharedStores();
    // The clone is addressable, and the process dies before the seed returns —
    // the window the pending marker used to miss, when it was written only after.
    stores.seed.mockImplementationOnce(async (request: WorktreeSeedRequest) => {
      stores.cloneSibling(request);
      return never();
    });
    const killed = processOver(stores);
    void killed.ops.run(TARGET);
    await vi.waitFor(() => {
      expect(stores.collections.has("code_wt")).toBe(true);
    });

    const next = processOver(stores);
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();

    expect(stores.seed).toHaveBeenCalledTimes(1);
    expect(stores.registry.get("code_wt")).toEqual(SEED_STAMP);
    expect(next.deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");
  });

  it("killed during the seeded incremental: the next run stamps the versions and rebuilds the git layer", async () => {
    const stores = sharedStores();
    const killed = processOver(stores, { reindexChanges: never });
    void killed.ops.run(TARGET);
    await vi.waitFor(() => {
      expect(killed.deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    });

    const next = processOver(stores);
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();

    expect(stores.seed).toHaveBeenCalledTimes(1);
    expect(next.deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(stores.stampLanguageVersions).toHaveBeenCalledWith("code_wt", SEED_STAMP);
    expect(next.deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");
  });

  it("stamps the SEEDING build's versions even when the resuming process runs another build", async () => {
    const stores = sharedStores();
    const killed = processOver(stores, { reindexChanges: never });
    void killed.ops.run(TARGET);
    await vi.waitFor(() => {
      expect(killed.deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    });

    // The upgraded build must not claim the cloned data as its own: drift then
    // reports walker 2 → 3, which is true.
    const upgraded = processOver(stores, {
      languageCodeVersions: new Map([
        ["typescript", { grammar: "0.23.2", chunking: 1, walker: 3, codegraphSchema: 1 }],
      ]),
    });
    await upgraded.ops.run(TARGET);
    await upgraded.ops.whenEnrichmentComplete();

    expect(stores.stampLanguageVersions).toHaveBeenCalledWith("code_wt", SEED_STAMP);
  });

  it("restarted during the background git rebuild: the next run rebuilds it again, then clears the seed", async () => {
    const stores = sharedStores();
    const restarted = processOver(stores, { recomputeEnrichments: never });
    await restarted.ops.run(TARGET);
    await vi.waitFor(() => {
      expect(restarted.deps.enrichment.recomputeEnrichments).toHaveBeenCalledTimes(1);
    });
    expect(stores.markers.get("code_wt")?.worktreeSeedPending).toBeDefined();

    const next = processOver(stores);
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();

    expect(next.deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");
  });

  it("keeps the seed pending when the git rebuild fails, so the next run retries it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stores = sharedStores();
    const failing = processOver(stores, { recomputeEnrichments: async () => Promise.reject(new Error("blame died")) });
    await failing.ops.run(TARGET);
    await failing.ops.whenEnrichmentComplete();

    expect(stores.markers.get("code_wt")?.worktreeSeedPending).toBeDefined();
    errors.mockRestore();
  });

  it("a seed that finished both leaves nothing pending — the next incremental is an ordinary one", async () => {
    const stores = sharedStores();
    const first = processOver(stores);
    await first.ops.run(TARGET);
    await first.ops.whenEnrichmentComplete();
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");

    stores.stampLanguageVersions.mockClear();
    const next = processOver(stores);
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();

    expect(stores.stampLanguageVersions).not.toHaveBeenCalled();
    expect(next.deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
  });
});

/**
 * The seeding process died, and the user followed the drift hint with a
 * `--force-enrichments` run instead of a plain incremental. The recompute is a
 * completed sync over the clone followed by a rebuild — so it can pay what the
 * seed owes, and must not leave behind a debt whose later settlement undoes it.
 */
describe("IndexingOps — a --force-enrichments recompute over a pending seed", () => {
  /** A seeding process killed during its seeded incremental: clone + pending marker, nothing settled. */
  async function killDuringSeededIncremental(stores: Stores): Promise<void> {
    const killed = processOver(stores, { reindexChanges: never });
    void killed.ops.run(TARGET);
    await vi.waitFor(() => {
      expect(killed.deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    });
    expect(stores.markers.get("code_wt")?.worktreeSeedPending).toBeDefined();
  }

  it.each([[["git"]], [["all"]], [["git", "codegraph"]]])(
    "recomputing git for every language (%j) settles the seed — the next incremental rebuilds nothing",
    async (forceEnrichments) => {
      const stores = sharedStores();
      await killDuringSeededIncremental(stores);

      const recompute = processOver(stores);
      await recompute.ops.run(TARGET, { forceEnrichments });
      await recompute.ops.whenEnrichmentComplete();

      expect(stores.registry.get("code_wt")).toEqual(SEED_STAMP);
      expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");

      const next = processOver(stores);
      await next.ops.run(TARGET);
      await next.ops.whenEnrichmentComplete();
      expect(next.deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
      expect(stores.registry.get("code_wt")).toEqual(SEED_STAMP);
    },
  );

  it("a git recompute narrowed to some languages pays the stamp but leaves the git rebuild owed", async () => {
    const stores = sharedStores();
    await killDuringSeededIncremental(stores);

    const recompute = processOver(stores);
    await recompute.ops.run(TARGET, { forceEnrichments: ["git"], languages: ["typescript"] });
    await recompute.ops.whenEnrichmentComplete();

    // Points of every other language still carry the sibling's git signals.
    expect(stores.registry.get("code_wt")).toEqual(SEED_STAMP);
    expect(stores.markers.get("code_wt")?.worktreeSeedPending).toBeDefined();

    const next = processOver(stores);
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();
    expect(next.deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");
  });

  it("a codegraph recompute keeps the git debt, and settling it later never rolls the newer stamp back", async () => {
    const stores = sharedStores();
    await killDuringSeededIncremental(stores);

    // The build moved on between the seed and the recompute: the recompute's
    // edge axes are newer than the seed's, and the seed's chunk-set axes are
    // still the only truthful claim about the cloned chunk set.
    const recompute = processOver(stores, { languageCodeVersions: UPGRADED_BUILD });
    await recompute.ops.run(TARGET, { forceEnrichments: ["codegraph"] });
    await recompute.ops.whenEnrichmentComplete();

    expect(stores.registry.get("code_wt")).toEqual(UPGRADED_STAMP);
    expect(stores.markers.get("code_wt")?.worktreeSeedPending).toBeDefined();

    const next = processOver(stores, { languageCodeVersions: UPGRADED_BUILD });
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();

    expect(next.deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");
    expect(stores.registry.get("code_wt")).toEqual(UPGRADED_STAMP);
  });

  it("with no recompute in between, the kill-before-settle resume still stamps the seed and rebuilds git", async () => {
    const stores = sharedStores();
    await killDuringSeededIncremental(stores);

    const next = processOver(stores, { languageCodeVersions: UPGRADED_BUILD });
    await next.ops.run(TARGET);
    await next.ops.whenEnrichmentComplete();

    expect(stores.registry.get("code_wt")).toEqual(SEED_STAMP);
    expect(next.deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
    expect(stores.markers.get("code_wt")).not.toHaveProperty("worktreeSeedPending");
  });

  it("a recompute over a collection with no pending seed stamps only its own axes", async () => {
    const stores = sharedStores();
    const first = processOver(stores);
    await first.ops.run(TARGET);
    await first.ops.whenEnrichmentComplete();
    stores.stampLanguageVersions.mockClear();

    const recompute = processOver(stores, { languageCodeVersions: UPGRADED_BUILD });
    await recompute.ops.run(TARGET, { forceEnrichments: ["codegraph"] });
    await recompute.ops.whenEnrichmentComplete();

    expect(stores.stampLanguageVersions).toHaveBeenCalledTimes(1);
    expect(stores.stampLanguageVersions).toHaveBeenCalledWith("code_wt", {
      typescript: { walker: 3, codegraphSchema: 1 },
    });
  });
});
