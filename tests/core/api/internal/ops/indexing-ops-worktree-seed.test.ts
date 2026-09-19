/**
 * IndexingOps — a first index seeded from a sibling working tree
 * (bd tea-rags-mcp-k8gac).
 *
 * The seed only replaces WHERE a first index starts: once the sibling's
 * footprint is cloned, the run is the ordinary incremental one, so it re-embeds
 * exactly the files whose content differs. What this layer adds is the branch,
 * the collection claims, the stamps a fresh index would have written, and the
 * git layer — whose signals depend on THIS worktree's history, not the
 * sibling's, so it is rebuilt as the run's background enrichment.
 */

import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type {
  WorktreeSeedAttempt,
  WorktreeSeedRequest,
} from "../../../../../src/core/api/internal/ops/worktree-seed-ops.js";
import type { LanguageCodeVersions } from "../../../../../src/core/contracts/types/language.js";
import { IndexingAlreadyInProgressError } from "../../../../../src/core/domains/ingest/errors.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const TARGET = resolve("/repo/wt");
const SIBLING = resolve("/repo/main");
const collectionOf = (path: string): string => (path === SIBLING ? "code_main" : "code_wt");

const changeStats: ChangeStats = {
  filesAdded: 2,
  filesModified: 3,
  filesDeleted: 1,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 9,
  chunksDeleted: 4,
  durationMs: 5,
  status: "completed",
  enrichmentStatus: "background",
};

const languageCodeVersions = new Map<string, LanguageCodeVersions>([
  ["typescript", { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 }],
]);

const SEEDED: WorktreeSeedAttempt = {
  status: "seeded",
  source: { collectionName: "code_main", project: "main", path: SIBLING },
  sourceFiles: 100,
  rejected: [],
};

function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  return { open, opened };
}

interface Harness {
  deps: IndexingOpsDeps;
  seed: ReturnType<typeof vi.fn>;
  existing: Set<string>;
}

function harness(
  seedImpl: (request: WorktreeSeedRequest, existing: Set<string>) => Promise<WorktreeSeedAttempt>,
  overrides: Partial<IndexingOpsDeps> = {},
): Harness {
  const existing = new Set<string>();
  const seed = vi.fn(async (request: WorktreeSeedRequest) => seedImpl(request, existing));
  const deps: IndexingOpsDeps = {
    qdrant: {
      isEmbedded: true,
      url: "http://127.0.0.1:6333",
      collectionExists: vi.fn(async (name: string) => existing.has(name)),
      aliases: {
        listAliases: vi.fn(async () => [...existing].map((a) => ({ aliasName: a, collectionName: `${a}_v1` }))),
      },
      listCollections: vi.fn(async () => []),
      getPoint: vi.fn(async () => null),
      getPointOrThrow: vi.fn(async () => null),
      // The seed's pending marker (write after the clone, clear once settled).
      setPayload: vi.fn().mockResolvedValue(undefined),
      batchDeletePayload: vi.fn().mockResolvedValue(undefined),
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      getModel: vi.fn(() => "nomic"),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn().mockResolvedValue({ status: "completed", filesIndexed: 7 }) } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      providerKeys: ["git", "codegraph"],
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    allPayloadSignals: [],
    languageCodeVersions,
    collectionRegistry: { stampLanguageVersions: vi.fn() },
    driftReporter: { reset: vi.fn() },
    resolveCollectionForPath: async (path) => Promise.resolve(collectionOf(path)),
    envSnapshot: { INGEST_CHUNK_SIZE: "2500" },
    worktreeSeed: { seed },
    ...overrides,
  };
  return { deps, seed, existing };
}

const seedsSibling = async (request: WorktreeSeedRequest, existing: Set<string>): Promise<WorktreeSeedAttempt> => {
  existing.add(request.targetCollection);
  return Promise.resolve(SEEDED);
};

describe("IndexingOps — first index seeded from a sibling worktree", () => {
  it("asks for a seed with the identity this run would stamp", async () => {
    const { deps, seed } = harness(seedsSibling);
    await new IndexingOps(deps).run(TARGET);

    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed.mock.calls[0][0]).toMatchObject({
      targetPath: TARGET,
      targetCollection: "code_wt",
      build: {
        payloadFieldKeys: ["navigation"],
        languageCodeVersions,
        envSnapshot: { INGEST_CHUNK_SIZE: "2500" },
        embeddingModel: "nomic",
        codegraphEnabled: false,
        qdrant: { embedded: true, url: "http://127.0.0.1:6333" },
      },
    });
  });

  it("hands the seed what the clone will owe, so the clone records it before it is visible (k8gac)", async () => {
    const { deps, seed } = harness(seedsSibling);
    await new IndexingOps(deps).run(TARGET);

    expect(seed.mock.calls[0][0]).toMatchObject({
      pending: {
        seededAt: expect.any(String),
        languageVersions: { typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 } },
      },
    });
  });

  it("runs the incremental path over the seeded collection instead of a full first index", async () => {
    const { deps } = harness(seedsSibling);
    const stats = await new IndexingOps(deps).run(TARGET);

    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(deps.reindex.reindexChanges).toHaveBeenCalledTimes(1);
    expect(stats.changeDetails).toMatchObject({ filesAdded: 2, filesModified: 3, filesDeleted: 1 });
  });

  it("reports the seed: which sibling, files copied verbatim vs embedded by this run", async () => {
    const { deps } = harness(seedsSibling);
    const stats = await new IndexingOps(deps).run(TARGET);

    expect(stats.worktreeSeed).toEqual({
      status: "seeded",
      source: { collectionName: "code_main", project: "main", path: SIBLING },
      // 100 in the sibling's snapshot, 3 of them changed here and 1 is gone.
      filesCopied: 96,
      filesIndexed: 5,
      filesRemoved: 1,
      gitRefresh: "background",
      rejected: [],
    });
  });

  it("stamps the full language versions a fresh index would, then re-arms the drift report", async () => {
    const { deps } = harness(seedsSibling);
    await new IndexingOps(deps).run(TARGET);

    // An incremental never stamps — this one does, because the seed gate proved
    // the sibling's data was produced by exactly this build.
    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
    expect(deps.collectionRegistry?.stampLanguageVersions).toHaveBeenCalledWith("code_wt", {
      typescript: { grammar: "0.23.2", chunking: 1, walker: 2, codegraphSchema: 1 },
    });
    expect(deps.driftReporter?.reset).toHaveBeenLastCalledWith("code_wt");
  });

  it("rebuilds the git layer of the whole seeded collection against this worktree's history", async () => {
    const { deps } = harness(seedsSibling);
    const ops = new IndexingOps(deps);
    await ops.run(TARGET);
    await ops.whenEnrichmentComplete();

    expect(deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith("code_wt_v1", TARGET, ["git"]);
  });

  it("skips the git rebuild when the git trajectory is off", async () => {
    const { deps } = harness(seedsSibling, {
      enrichment: {
        providerKeys: ["codegraph"],
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
        runRecovery: vi.fn().mockResolvedValue(undefined),
        recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
      } as never,
    });
    const ops = new IndexingOps(deps);
    const stats = await ops.run(TARGET);
    await ops.whenEnrichmentComplete();

    expect(deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
    expect(stats.worktreeSeed).toMatchObject({ status: "seeded", gitRefresh: "not-applicable" });
  });

  it("keeps the new collection claimed until the git rebuild settles", async () => {
    const refresh = gate();
    const recomputeEnrichments = vi.fn(async () => {
      await refresh.opened;
    });
    const { deps } = harness(seedsSibling, {
      enrichment: {
        providerKeys: ["git"],
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
        runRecovery: vi.fn().mockResolvedValue(undefined),
        recomputeEnrichments,
      } as never,
    });
    const ops = new IndexingOps(deps);

    await ops.run(TARGET);
    await vi.waitFor(() => {
      expect(recomputeEnrichments).toHaveBeenCalledTimes(1);
    });
    await expect(ops.run(TARGET)).rejects.toBeInstanceOf(IndexingAlreadyInProgressError);

    refresh.open();
    await ops.whenEnrichmentComplete();
    await expect(ops.run(TARGET)).resolves.toMatchObject({ status: "completed" });
  });

  it("never fails the index because the background git rebuild failed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { deps } = harness(seedsSibling, {
      enrichment: {
        providerKeys: ["git"],
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
        runRecovery: vi.fn().mockResolvedValue(undefined),
        recomputeEnrichments: vi.fn().mockRejectedValue(new Error("blame pool died")),
      } as never,
    });
    const ops = new IndexingOps(deps);

    await expect(ops.run(TARGET)).resolves.toMatchObject({ worktreeSeed: { status: "seeded" } });
    await ops.whenEnrichmentComplete();
    expect(errors.mock.calls.some((call) => String(call[1]).includes("blame pool died"))).toBe(true);
    errors.mockRestore();
  });

  it("drops the seeded collection again when the run over it fails, so the next attempt starts clean", async () => {
    const { deps, existing } = harness(seedsSibling, {
      reindex: { reindexChanges: vi.fn().mockRejectedValue(new Error("embedding endpoint down")) } as never,
    });
    const ops = new IndexingOps(deps);
    const clear = vi.spyOn(ops, "clear").mockImplementation(async () => {
      existing.clear();
      return Promise.resolve();
    });

    await expect(ops.run(TARGET)).rejects.toThrow("embedding endpoint down");
    expect(clear).toHaveBeenCalledWith(TARGET);
    expect(existing.size).toBe(0);
  });

  it("falls back to an ordinary first index when no sibling may seed, and says why", async () => {
    const rejected = [
      {
        collectionName: "code_main",
        project: "main",
        path: SIBLING,
        reason: "embedding-model" as const,
        detail: "sibling embedded with jina, this run with nomic",
      },
    ];
    const { deps } = harness(async () =>
      Promise.resolve({ status: "skipped", reason: "no-compatible-sibling", rejected } as const),
    );
    const stats = await new IndexingOps(deps).run(TARGET);

    expect(deps.indexing.indexCodebase).toHaveBeenCalledTimes(1);
    expect(stats.worktreeSeed).toEqual({ status: "skipped", reason: "no-compatible-sibling", rejected });
  });

  it("indexes from scratch when the reported seed left no collection behind", async () => {
    const { deps } = harness(async () => Promise.resolve(SEEDED));
    const stats = await new IndexingOps(deps).run(TARGET);

    expect(deps.indexing.indexCodebase).toHaveBeenCalledTimes(1);
    expect(stats.worktreeSeed).toMatchObject({
      status: "skipped",
      reason: "no-compatible-sibling",
      rejected: [{ collectionName: "code_main", reason: "clone-failed" }],
    });
  });

  it("does not seed when the caller opts out", async () => {
    const { deps, seed } = harness(seedsSibling);
    const stats = await new IndexingOps(deps).run(TARGET, { seedFromWorktree: false });

    expect(seed).not.toHaveBeenCalled();
    expect(deps.indexing.indexCodebase).toHaveBeenCalledTimes(1);
    expect(stats.worktreeSeed).toEqual({ status: "skipped", reason: "disabled", rejected: [] });
  });

  it("does not seed a run restricted to other extensions or ignore patterns — the sibling holds what IT indexed", async () => {
    const { deps, seed } = harness(seedsSibling);
    const stats = await new IndexingOps(deps).run(TARGET, { extensions: [".proto"] });

    expect(seed).not.toHaveBeenCalled();
    expect(stats.worktreeSeed).toEqual({ status: "skipped", reason: "restricted-run", rejected: [] });
  });

  it("does not seed a forced reindex, and reports nothing about seeding", async () => {
    const { deps, seed } = harness(seedsSibling);
    const stats = await new IndexingOps(deps).run(TARGET, { forceReindex: true });

    expect(seed).not.toHaveBeenCalled();
    expect(stats.worktreeSeed).toBeUndefined();
  });

  it("does not seed a collection that already exists", async () => {
    const { deps, seed, existing } = harness(seedsSibling);
    existing.add("code_wt");
    const stats = await new IndexingOps(deps).run(TARGET);

    expect(seed).not.toHaveBeenCalled();
    expect(stats.worktreeSeed).toBeUndefined();
  });

  describe("claiming the sibling for the clone", () => {
    it("refuses a sibling this process is indexing", async () => {
      const held = gate();
      let claimed: unknown = "not asked";
      const { deps, existing } = harness(async (request) => {
        claimed = await request.claimSource("code_main");
        return { status: "skipped", reason: "no-compatible-sibling", rejected: [] };
      });
      const reindexChanges = vi.fn(async () => {
        await held.opened;
        return changeStats;
      });
      deps.reindex = { reindexChanges } as never;
      const ops = new IndexingOps(deps);
      // The sibling is indexed, and an incremental run of this ops is on it.
      existing.add("code_main");

      const siblingRun = ops.run(SIBLING);
      await vi.waitFor(() => {
        expect(reindexChanges).toHaveBeenCalledTimes(1);
      });
      await ops.run(TARGET);

      expect(claimed).toBeUndefined();
      held.open();
      await siblingRun;
    });

    it("holds the sibling for the clone's duration — an index run on it is refused until release", async () => {
      let siblingRunWhileHeld: Promise<unknown> | undefined;
      const { deps, existing } = harness(async (request, collections) => {
        const release = await request.claimSource("code_main");
        siblingRunWhileHeld = ops.run(SIBLING).catch((error: unknown) => error);
        await siblingRunWhileHeld;
        await release?.();
        collections.add(request.targetCollection);
        return SEEDED;
      });
      const ops = new IndexingOps(deps);

      await ops.run(TARGET);

      expect(await siblingRunWhileHeld).toBeInstanceOf(IndexingAlreadyInProgressError);
      await ops.whenEnrichmentComplete();
      existing.add("code_main");
      await expect(ops.run(SIBLING)).resolves.toMatchObject({ status: "completed" });
    });
  });
});
