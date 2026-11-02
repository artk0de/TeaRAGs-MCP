/**
 * One provider's failure is that provider's, not the run's (bd tea-rags-mcp-xvik1).
 *
 * Live: a project whose codegraph daemon could not start (socket listen EINVAL)
 * made `--force-enrichments git,codegraph` exit 1 with a top-level UNKNOWN
 * "Worker error: No codegraph daemon is running …" — the forced codegraph
 * repair threw out of `recomputeEnrichments` before git ever wrote. A first
 * index on the same project ended with git AND codegraph `failed`: the
 * codegraph finalize threw out of `CompletionRunner#run`, which settled every
 * provider's terminal markers as failed. `GitEnrichmentProvider` never touches
 * the daemon. What these pin:
 *
 * - recompute: a store provider whose forced repair dispatch throws is marked
 *   failed in the run; git streams, writes and ends `completed`; the recompute
 *   resolves instead of rejecting.
 * - completion: a codegraph finalize that throws marks codegraph failed; git
 *   still finalizes and ends `completed`; the run resolves.
 * - run-fatal errors (Qdrant cold) are never isolated: they still reject.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import { QdrantUnavailableError } from "../../../../../../src/core/adapters/qdrant/errors.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/contracts/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";
import type {
  EnrichmentProvider,
  FileFinalInput,
} from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

const DAEMON_DOWN =
  "Worker error: No codegraph daemon is running for this process's build (key k, socket /tmp/s) and this pool cannot spawn one";

afterEach(() => {
  vi.restoreAllMocks();
});

function gitProvider(): EnrichmentProvider {
  return {
    key: "git",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(
      new Map([
        ["src/a.ts", { commitCount: 3 }],
        ["src/b.ts", { commitCount: 5 }],
      ]),
    ),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  };
}

function codegraphProvider(overrides: Partial<EnrichmentProvider> = {}): EnrichmentProvider {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    defersChunkEnrichment: true,
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn().mockResolvedValue(new Map<string, string | null>()),
    ...overrides,
  };
}

const STORED_POINTS = [
  { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
  { id: "c2", payload: { relativePath: "src/b.ts", startLine: 1, endLine: 10 } },
];

function recomputeQdrant() {
  return {
    scrollFiltered: vi.fn().mockResolvedValue(STORED_POINTS),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    batchDeletePayload: vi.fn().mockResolvedValue(undefined),
    deletePayloadKeys: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

function captureFileTerminals(): Map<string, FileFinalInput> {
  const terminals = new Map<string, FileFinalInput>();
  vi.spyOn(EnrichmentMarkerStore.prototype, "markFileFinal").mockImplementation(async (_coll, providerKey, input) => {
    terminals.set(providerKey, input);
  });
  return terminals;
}

function writtenKeys(qdrant: ReturnType<typeof recomputeQdrant>): string[] {
  return qdrant.batchSetPayload.mock.calls.flatMap(([, ops]) => (ops as { key?: string }[]).map((op) => op.key ?? ""));
}

describe("recomputeEnrichments isolates a provider whose forced repair fails (xvik1)", () => {
  it("marks only codegraph failed; git streams, writes and completes; the recompute resolves", async () => {
    const terminals = captureFileTerminals();
    const qdrant = recomputeQdrant();
    const executor = new InlineEnrichmentExecutor();
    const runFileBatch = executor.runFileBatch.bind(executor);
    vi.spyOn(executor, "runFileBatch").mockImplementation(async (provider, root, paths, options) => {
      if (provider.key === "codegraph.symbols") throw new Error(DAEMON_DOWN);
      return runFileBatch(provider, root, paths, options);
    });
    const git = gitProvider();
    const coordinator = new EnrichmentCoordinator(qdrant as never, [git, codegraphProvider()], undefined, executor);

    await expect(
      coordinator.recomputeEnrichments(fixturePhysicalCollectionName("code_x_v1"), "/repo", ["git", "codegraph"]),
    ).resolves.toBeDefined();

    expect(git.buildFileSignals).toHaveBeenCalled();
    expect(writtenKeys(qdrant)).toContain("git.file");
    expect(terminals.get("git")?.status).toBe("completed");
    expect(terminals.get("codegraph.symbols")).toEqual(
      expect.objectContaining({ status: "failed", errorMessage: DAEMON_DOWN }),
    );
  });

  it("keeps a run-fatal repair failure fatal: Qdrant cold still rejects the recompute", async () => {
    captureFileTerminals();
    const executor = new InlineEnrichmentExecutor();
    const coldQdrant = new QdrantUnavailableError("http://localhost:6333");
    vi.spyOn(executor, "runFileBatch").mockRejectedValue(coldQdrant);
    const coordinator = new EnrichmentCoordinator(
      recomputeQdrant() as never,
      [gitProvider(), codegraphProvider()],
      undefined,
      executor,
    );

    await expect(
      coordinator.recomputeEnrichments(fixturePhysicalCollectionName("code_x_v1"), "/repo", ["git", "codegraph"]),
    ).rejects.toBe(coldQdrant);
  });
});

async function completionHarness(codegraphFinalize: () => Promise<never>) {
  const qdrant = new MockQdrantManager();
  await qdrant.createCollection("coll", 384);
  await qdrant.addPoints("coll", [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
  const executor = new InlineEnrichmentExecutor();
  const runFinalize = executor.runFinalize.bind(executor);
  vi.spyOn(executor, "runFinalize").mockImplementation(async (provider, root, options) =>
    provider.key === "codegraph.symbols" ? codegraphFinalize() : runFinalize(provider, root, options),
  );
  const applier = new EnrichmentApplier(qdrant as never);
  const marker = new EnrichmentMarkerStore(qdrant as never);
  const filePhase = new FilePhase(applier, marker, executor);
  const chunkPhase = new ChunkPhase(applier, executor);
  filePhase.bindChunkPhase(chunkPhase);
  const backfiller = new EnrichmentBackfiller(applier, qdrant as never, executor);
  const runner = new CompletionRunner({ filePhase, chunkPhase, backfiller, applier, markerStore: marker, executor });
  const git = { ...gitProvider(), finalizeSignals: vi.fn().mockResolvedValue(new Map()) };
  const contexts = new Map<string, unknown>([
    [
      "codegraph.symbols",
      { key: "codegraph.symbols", provider: codegraphProvider(), effectiveRoot: "/repo", ignoreFilter: null },
    ],
    ["git", { key: "git", provider: git, effectiveRoot: "/repo", ignoreFilter: null }],
  ]);
  filePhase.init(contexts as never, fixturePhysicalCollectionName("coll"), "run-1", "ts");
  chunkPhase.init(contexts as never, fixturePhysicalCollectionName("coll"), "ts");
  return { runner, contexts, git };
}

describe("CompletionRunner isolates a provider whose finalize fails (xvik1)", () => {
  it("marks only codegraph failed; git finalizes and completes; the run resolves", async () => {
    const terminals = captureFileTerminals();
    const { runner, contexts, git } = await completionHarness(async () => {
      throw new Error(DAEMON_DOWN);
    });

    await expect(
      runner.run(fixturePhysicalCollectionName("coll"), contexts as never, Date.now() - 1000, undefined, "ts", "run-1"),
    ).resolves.toBeDefined();

    expect(git.finalizeSignals).toHaveBeenCalled();
    expect(terminals.get("git")?.status).toBe("completed");
    expect(terminals.get("codegraph.symbols")).toEqual(
      expect.objectContaining({ status: "failed", errorMessage: DAEMON_DOWN }),
    );
  });

  it("keeps a run-fatal finalize failure fatal: Qdrant cold still rejects the run", async () => {
    captureFileTerminals();
    const coldQdrant = new QdrantUnavailableError("http://localhost:6333");
    const { runner, contexts } = await completionHarness(async () => {
      throw coldQdrant;
    });

    await expect(
      runner.run(fixturePhysicalCollectionName("coll"), contexts as never, Date.now() - 1000, undefined, "ts", "run-1"),
    ).rejects.toBe(coldQdrant);
  });
});
