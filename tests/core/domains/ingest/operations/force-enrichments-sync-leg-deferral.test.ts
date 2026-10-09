/**
 * `--force-enrichments <selectors>` — the sync leg leaves the SELECTED
 * providers to the recompute that follows it (bd tea-rags-mcp-b4drg).
 *
 * `IndexingOps#recomputeEnrichments` runs an ordinary incremental first
 * (`ReindexPipeline#reindexChanges`), then the recompute
 * (`EnrichmentCoordinator#recomputeEnrichments`), whose forced provider repair
 * walks every eligible file (bd tea-rags-mcp-cneu7) and whose run completes the
 * collection. Measured on taxdome 2026-10-09, the sync leg still ran the
 * selected codegraph provider's per-file extraction for 2.9k changed files AND
 * its whole-collection completion (fileFinalize 56 s, heal 17 s, chunkMarkers
 * 26 s, co-change rebuild) — all of it redone by the recompute.
 *
 * Pinned here, through the wired facade:
 * - the sync leg starts no extraction, finalize or collection completion for
 *   the selected provider, while a NON-selected provider keeps its ordinary
 *   incremental work;
 * - deletions still reach the selected provider's `handleDeletedPaths` — the
 *   recompute's selector-forced repair never prunes orphans;
 * - the selected provider's completion runs exactly once over the whole
 *   operation, from the recompute;
 * - a plain incremental (MCP `index_codebase`, auto-update) is untouched;
 * - a `--languages` recompute that does not cover a changed file declines the
 *   deferral, since nothing would enrich that file otherwise.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupTempDir,
  createTempTestDir,
  createTestFile,
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../__helpers__/test-helpers.js";
import { warmChunkerPoolFactory } from "../__helpers__/warm-chunker-pool.js";
import { IngestFacade } from "../../../../../src/core/api/index.js";
import type { EnrichmentExecutor } from "../../../../../src/core/contracts/types/enrichment-executor.js";
import type { EnrichmentProvider } from "../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    setLanguage() {}
    parse() {
      return {
        rootNode: {
          type: "program",
          startPosition: { row: 0, column: 0 },
          endPosition: { row: 0, column: 0 },
          children: [],
          text: "",
          namedChildren: [],
        },
      };
    }
  },
}));
vi.mock("tree-sitter-bash", () => ({ default: {} }));
vi.mock("tree-sitter-go", () => ({ default: {} }));
vi.mock("tree-sitter-java", () => ({ default: {} }));
vi.mock("tree-sitter-javascript", () => ({ default: {} }));
vi.mock("tree-sitter-python", () => ({ default: {} }));
vi.mock("tree-sitter-ruby", () => ({ default: {} }));
vi.mock("tree-sitter-rust", () => ({ default: {} }));
vi.mock("tree-sitter-typescript", () => ({ default: { typescript: {}, tsx: {} } }));

const GRAPH_KEY = "codegraph.symbols";
const GIT_KEY = "git";
/** Captured once, so a spy a failed hook left in place is never wrapped again. */
const originalRecomputeEnrichments = EnrichmentCoordinator.prototype.recomputeEnrichments;
/** Marks where the recompute leg begins in `events`. */
const RECOMPUTE = "RECOMPUTE";

/**
 * Every provider-visible step, in order: `<key>:extract:<path>`,
 * `<key>:finalize`, `<key>:completeCollection`, `<key>:delete:<path>`, plus
 * the {@link RECOMPUTE} boundary.
 */
const events: string[] = [];
/** What the fake graph store "persisted": content hashes of the last extraction, like the real rows. */
const persistedHashes = new Map<string, string>();

function baseProvider(key: string): EnrichmentProvider {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  };
}

function graphProvider(): EnrichmentProvider {
  return {
    ...baseProvider(GRAPH_KEY),
    streamFileBatch: vi.fn().mockResolvedValue(new Map()),
    finalizeSignals: vi.fn().mockResolvedValue(new Map()),
    readPersistedFileHashes: vi.fn(async () => new Map<string, string | null>(persistedHashes)),
    handleDeletedPaths: vi.fn(async (paths: string[]) => {
      for (const path of paths) {
        events.push(`${GRAPH_KEY}:delete:${path}`);
        persistedHashes.delete(path);
      }
    }),
    completeCollection: vi.fn(async () => {
      events.push(`${GRAPH_KEY}:completeCollection`);
    }),
  };
}

function recordingExecutor(): EnrichmentExecutor {
  return {
    runFileBatch: vi.fn(
      async (
        provider: EnrichmentProvider,
        _root,
        paths: string[],
        options?: { contentHashes?: ReadonlyMap<string, string> },
      ) => {
        for (const path of paths) {
          events.push(`${provider.key}:extract:${path}`);
          const hash = options?.contentHashes?.get(path);
          if (hash && provider.key === GRAPH_KEY) persistedHashes.set(path, hash);
        }
        return new Map();
      },
    ),
    runFileSignalsRecovery: vi.fn().mockResolvedValue(new Map()),
    runChunkBatch: vi.fn().mockResolvedValue(new Map()),
    runFinalize: vi.fn(async (provider: EnrichmentProvider) => {
      events.push(`${provider.key}:finalize`);
      return new Map();
    }),
    releaseRun: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

/** A file big enough for the chunker to emit points for. */
function sourceOf(name: string): string {
  return Array.from({ length: 60 }, (_, i) => `export const ${name}Value${i} = ${i};`).join("\n");
}

/**
 * The events before the recompute leg began — the sync leg's. A completion the
 * sync leg started settles in the background and may land after the boundary,
 * so completions are also counted over the whole operation below.
 */
function syncLegEvents(): string[] {
  const boundary = events.indexOf(RECOMPUTE);
  return boundary === -1 ? [...events] : events.slice(0, boundary);
}

function graphEvents(list: readonly string[]): string[] {
  return list.filter((event) => event.startsWith(`${GRAPH_KEY}:`));
}

describe("--force-enrichments — the sync leg leaves the selected providers to the recompute (bd tea-rags-mcp-b4drg)", () => {
  let ingest: IngestFacade;
  let tempDir: string;
  let codebaseDir: string;

  beforeEach(async () => {
    events.length = 0;
    persistedHashes.clear();
    ({ tempDir, codebaseDir } = await createTempTestDir());
    ingest = new IngestFacade({
      qdrant: new MockQdrantManager() as never,
      embeddings: new MockEmbeddingProvider(),
      config: { ...defaultTestConfig(), supportedExtensions: [".ts", ".py"] },
      trajectoryConfig: defaultTrajectoryConfig(),
      createChunkerPool: warmChunkerPoolFactory,
      enrichmentProviders: [baseProvider(GIT_KEY), graphProvider()],
      enrichmentExecutor: recordingExecutor(),
    } as never);
    await createTestFile(codebaseDir, "app.ts", sourceOf("app"));
    await createTestFile(codebaseDir, "util.ts", sourceOf("util"));
    // First index, then one plain incremental so the fake store is current —
    // the state a real `--force-enrichments` run starts from.
    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();
    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();

    const recompute = originalRecomputeEnrichments;
    vi.spyOn(EnrichmentCoordinator.prototype, "recomputeEnrichments").mockImplementation(async function (
      this: EnrichmentCoordinator,
      ...args: Parameters<EnrichmentCoordinator["recomputeEnrichments"]>
    ) {
      events.push(RECOMPUTE);
      return recompute.apply(this, args);
    });
    events.length = 0;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDir(tempDir);
  });

  async function forceEnrichments(options: { languages?: string[] } = {}): Promise<void> {
    await ingest.indexCodebase(codebaseDir, { forceEnrichments: ["codegraph"], ...options });
    await ingest.whenEnrichmentComplete();
  }

  it("starts no graph extraction, finalize or completion in the sync leg, while git still enriches the changed file", async () => {
    await createTestFile(codebaseDir, "util.ts", sourceOf("changed"));
    await createTestFile(codebaseDir, "added.ts", sourceOf("added"));

    await forceEnrichments();

    const syncLeg = syncLegEvents();
    expect(events).toContain(RECOMPUTE);
    expect(graphEvents(syncLeg)).toEqual([]);
    expect(syncLeg).toEqual(expect.arrayContaining([`${GIT_KEY}:extract:util.ts`, `${GIT_KEY}:extract:added.ts`]));
  });

  it("still hands deleted files to the graph provider's deletion hook in the sync leg", async () => {
    await fs.unlink(join(codebaseDir, "util.ts"));
    await createTestFile(codebaseDir, "app.ts", sourceOf("changed"));

    await forceEnrichments();

    // Reached twice today, both kept: the repair's orphan prune and the
    // deletion leg's hook (`EnrichmentCoordinator#notifyDeletions`). Nothing
    // else of the graph provider runs in the sync leg.
    const graphSyncLeg = graphEvents(syncLegEvents());
    expect(graphSyncLeg).toContain(`${GRAPH_KEY}:delete:util.ts`);
    expect(new Set(graphSyncLeg)).toEqual(new Set([`${GRAPH_KEY}:delete:util.ts`]));
  });

  it("completes the graph provider exactly once over the whole operation, from the recompute", async () => {
    await createTestFile(codebaseDir, "util.ts", sourceOf("changed"));

    await forceEnrichments();

    // Counted over the whole operation: the sync leg's completion settles in
    // the background, so it could land after the recompute leg began.
    expect(events.filter((event) => event === `${GRAPH_KEY}:finalize`)).toHaveLength(1);
    expect(events.filter((event) => event === `${GRAPH_KEY}:completeCollection`)).toHaveLength(1);
    expect(events.indexOf(`${GRAPH_KEY}:completeCollection`)).toBeGreaterThan(events.indexOf(RECOMPUTE));
    // The recompute re-extracts the changed file itself — nothing was lost.
    expect(events.slice(events.indexOf(RECOMPUTE))).toContain(`${GRAPH_KEY}:extract:util.ts`);
  });

  it("leaves a plain incremental alone — every provider still enriches and completes", async () => {
    await createTestFile(codebaseDir, "util.ts", sourceOf("changed"));

    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();

    expect(events).not.toContain(RECOMPUTE);
    expect(events).toEqual(
      expect.arrayContaining([
        `${GIT_KEY}:extract:util.ts`,
        `${GRAPH_KEY}:extract:util.ts`,
        `${GRAPH_KEY}:finalize`,
        `${GRAPH_KEY}:completeCollection`,
      ]),
    );
  });

  it("defers a covered drift repair, but walks a drifted file outside --languages and keeps the provider", async () => {
    await createTestFile(codebaseDir, "tool.py", Array.from({ length: 60 }, (_, i) => `v${i} = ${i}`).join("\n"));
    await ingest.indexCodebase(codebaseDir);
    await ingest.whenEnrichmentComplete();
    events.length = 0;
    await createTestFile(codebaseDir, "util.ts", sourceOf("changed"));

    // Covered: only a TypeScript file changed, the recompute covers TypeScript.
    await forceEnrichments({ languages: ["typescript"] });
    expect(graphEvents(syncLegEvents())).toEqual([]);

    // Uncovered drift: the store fell behind on an unchanged python file the
    // typescript recompute never reaches, so only the sync leg can heal it.
    events.length = 0;
    persistedHashes.set("tool.py", "drifted");
    await createTestFile(codebaseDir, "util.ts", sourceOf("changedAgain"));
    await forceEnrichments({ languages: ["typescript"] });
    expect(graphEvents(syncLegEvents())).toEqual(
      expect.arrayContaining([`${GRAPH_KEY}:extract:tool.py`, `${GRAPH_KEY}:extract:util.ts`, `${GRAPH_KEY}:finalize`]),
    );
  });

  it("declines the deferral when the recompute's languages do not cover a changed file", async () => {
    // A python recompute never scrolls or repairs the TypeScript file, so the
    // sync leg is the only leg that can enrich it.
    await createTestFile(codebaseDir, "tool.py", Array.from({ length: 60 }, (_, i) => `v${i} = ${i}`).join("\n"));
    await createTestFile(codebaseDir, "util.ts", sourceOf("changed"));

    await forceEnrichments({ languages: ["python"] });

    expect(graphEvents(syncLegEvents())).toEqual(
      expect.arrayContaining([`${GRAPH_KEY}:extract:util.ts`, `${GRAPH_KEY}:finalize`]),
    );
  });
});
