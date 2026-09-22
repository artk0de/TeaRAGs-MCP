/**
 * Enrichment lifecycle harness — REAL collaborators end to end (bd tea-rags-mcp-39xca.7).
 *
 * The defects this harness pins lived between components that the coordinator's
 * unit suite replaces with doubles: a worker thread's provider cache evicted by
 * another run's release, a terminal marker landing under a newer run's `_run`
 * pointer, a daemon from another build answering a hookless pool. Here nothing on
 * that path is mocked:
 *
 *   - `EnrichmentCoordinator` as the pipeline drives it (or built by a real
 *     `IngestFacade`, for the index-operation scenarios);
 *   - `WorkerPoolEnrichmentExecutor` running the COMPILED enrichment worker
 *     (`build/…/enrichment/infra/worker.js` — run `npm run build` first);
 *   - the codegraph provider rebuilt in that worker from its serializable
 *     descriptor, exactly as `wireCodegraph` ships it (collection affinity);
 *   - a real codegraph daemon (`runDaemon`, in-process, its own socket) over a
 *     per-test DuckDB file, which both the worker's and the main thread's pools
 *     reach — the production write path;
 *   - an in-memory Qdrant (`MockQdrantManager`), which models `set_payload` with a
 *     nested `key` the way the pipeline relies on. It ignores scroll and count
 *     filters; the recompute tolerates that (the metadata point has no
 *     `relativePath`), and recovery's settle poll only costs one short delay.
 *
 * Every artifact — repo fixture, DuckDB root, daemon socket, snapshots — lives
 * under one `mkdtemp` directory, so nothing touches the machine's `~/.tea-rags`
 * daemon, Qdrant or registry.
 *
 * The fixture is a three-file TypeScript project whose `outer` function holds a
 * nested closure `outer.inner` and is stored as two `#part` chunks; the second
 * part starts inside the closure, so the codegraph chunk-owner rule assigns it
 * the NESTED symbol only when the deferred pass can read the walker's ranges.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  defaultTestConfig,
  defaultTrajectoryConfig,
  MockEmbeddingProvider,
  MockQdrantManager,
} from "../../../../__helpers__/test-helpers.js";
import { DaemonGraphDbClient } from "../../../../../../../../src/core/adapters/duckdb/daemon/client.js";
import { runDaemon } from "../../../../../../../../src/core/adapters/duckdb/daemon/entry.js";
import {
  getDaemonPaths,
  type CodegraphDaemonPaths,
} from "../../../../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";
import {
  DAEMON_OP_COMMANDS,
  type DaemonOpCommandTable,
} from "../../../../../../../../src/core/adapters/duckdb/daemon/op-commands.js";
import type { DaemonOp } from "../../../../../../../../src/core/adapters/duckdb/daemon/protocol.js";
import { GraphDbClientPool } from "../../../../../../../../src/core/adapters/duckdb/pool.js";
import { IngestFacade } from "../../../../../../../../src/core/api/index.js";
import { INDEXING_METADATA_ID } from "../../../../../../../../src/core/contracts/constants.js";
import type { SymbolDefinition } from "../../../../../../../../src/core/contracts/types/codegraph.js";
import type { EnrichmentRunHandle } from "../../../../../../../../src/core/contracts/types/enrichment-executor.js";
import type {
  ChunkSignalOverlay,
  EnrichmentProvider,
  WorkerEnrichmentDescriptor,
} from "../../../../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { WorkerPoolEnrichmentExecutor } from "../../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";
import type { ChunkItem } from "../../../../../../../../src/core/domains/ingest/pipeline/types.js";
import { LanguageFactory } from "../../../../../../../../src/core/domains/language/index.js";
import { collectSymbols } from "../../../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../../../../src/core/domains/language/kernel/symbol-id.js";
import {
  createDatabaseMigrationApplier,
  DATABASE_MIGRATIONS_MODULE_URL,
} from "../../../../../../../../src/core/domains/maintenance/migration/database/index.js";
import type { CodegraphWorkerConfig } from "../../../../../../../../src/core/domains/trajectory/codegraph/factory.js";
import { buildCodegraphChunkSignals } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { CodegraphEnrichmentProvider } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import type { ChunkLookupEntry } from "../../../../../../../../src/core/types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../../..");
const BUILD = join(REPO_ROOT, "build/core");
const WORKER_PATH = join(BUILD, "domains/ingest/pipeline/enrichment/infra/worker.js");
const CODEGRAPH_FACTORY_MODULE = join(BUILD, "domains/trajectory/codegraph/factory.js");
const LANGUAGE_MODULE = join(BUILD, "domains/language/index.js");
const MIGRATIONS_MODULE = join(BUILD, "domains/maintenance/migration/database/index.js");

export const CODEGRAPH_PROVIDER_KEY = "codegraph.symbols";
export const RUN_POINTER_KEY = "enrichment._run";
/** The payload subtree the deferred chunk pass writes. */
export const CHUNK_SIGNALS_KEY = `${CODEGRAPH_PROVIDER_KEY}.chunk`;

/** The outer function whose second `#part` chunk starts inside its nested closure. */
export const ANCHOR_SYMBOL = "outer";
export const NESTED_OWNER_SYMBOL = "outer.inner";

const FIXTURE_FILES: Readonly<Record<string, string>> = {
  "src/lib/helpers.ts": [
    "export function helperA(value: number): number {",
    "  return value + 1;",
    "}",
    "",
    "export function helperB(value: number): number {",
    "  return value * 2;",
    "}",
    "",
  ].join("\n"),
  "src/lib/outer.ts": [
    'import { helperA, helperB } from "./helpers";',
    "",
    "export function outer(seed: number): number {",
    "  const base = seed + 1;",
    "  const doubled = base * 2;",
    "  const shifted = doubled - 3;",
    "  function inner(value: number): number {",
    "    const a = helperA(value);",
    "    const b = helperB(value);",
    "    return a + b;",
    "  }",
    "  return inner(shifted);",
    "}",
    "",
  ].join("\n"),
  "src/app/caller.ts": [
    'import { outer } from "../lib/outer";',
    "",
    "export function main(): number {",
    "  return outer(1) + outer(2);",
    "}",
    "",
  ].join("\n"),
};

interface FixtureChunk {
  id: string;
  relPath: string;
  startLine: number;
  endLine: number;
  symbolId: string;
}

/**
 * Stored points as the chunker leaves them: `outer` is split into two parts, and
 * `outer#part2` (7-13) starts on the first line of `outer.inner` (7-11).
 */
const FIXTURE_CHUNKS: readonly FixtureChunk[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    relPath: "src/lib/helpers.ts",
    startLine: 1,
    endLine: 3,
    symbolId: "helperA",
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    relPath: "src/lib/helpers.ts",
    startLine: 5,
    endLine: 7,
    symbolId: "helperB",
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    relPath: "src/lib/outer.ts",
    startLine: 3,
    endLine: 6,
    symbolId: "outer#part1",
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    relPath: "src/lib/outer.ts",
    startLine: 7,
    endLine: 13,
    symbolId: "outer#part2",
  },
  {
    id: "00000000-0000-4000-8000-000000000005",
    relPath: "src/app/caller.ts",
    startLine: 3,
    endLine: 5,
    symbolId: "main",
  },
];

/** The `#part` chunk whose owner is the nested closure, not the anchor. */
export const NESTED_PART_CHUNK_ID = "00000000-0000-4000-8000-000000000004";
export const NESTED_PART_START_LINE = 7;

export type LifecycleEvent =
  | { kind: "scroll" }
  | { kind: "marker"; key: string; runId?: string }
  | { kind: "release"; runId: string; phase: "start" | "end" };

/** One `set_payload` op against the codegraph chunk subtree, as the applier sent it. */
export interface ChunkSignalsWrite {
  points: (string | number)[];
  payload: Record<string, unknown>;
}

/** In-memory Qdrant that logs, in order, the stored-chunk scroll and every enrichment payload write. */
export class RecordingQdrant extends MockQdrantManager {
  readonly events: LifecycleEvent[] = [];
  readonly chunkSignalWrites: ChunkSignalsWrite[] = [];

  override async scrollFiltered(
    ...args: Parameters<MockQdrantManager["scrollFiltered"]>
  ): ReturnType<MockQdrantManager["scrollFiltered"]> {
    this.events.push({ kind: "scroll" });
    return super.scrollFiltered(...args);
  }

  override async batchSetPayload(
    collectionName: string,
    operations: { payload: Record<string, any>; points: (string | number)[]; key?: string }[],
    options?: any,
  ): Promise<void> {
    for (const op of operations) {
      if (op.key?.startsWith("enrichment.")) {
        this.events.push({ kind: "marker", key: op.key, runId: op.payload.runId as string | undefined });
      }
      if (op.key === CHUNK_SIGNALS_KEY) {
        this.chunkSignalWrites.push({ points: [...op.points], payload: { ...op.payload } });
      }
    }
    await super.batchSetPayload(collectionName, operations, options);
  }
}

/** A point in a run's completion the test holds open, and the handle that lets it go. */
export interface CompletionHold {
  /** Settles once the held call has been reached. */
  reached: Promise<void>;
  release: () => void;
}

interface CompletionHoldControl extends CompletionHold {
  markReached: () => void;
  opened: Promise<void>;
}

function completionHold(): CompletionHoldControl {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((settle) => {
    markReached = settle;
  });
  const opened = new Promise<void>((settle) => {
    release = settle;
  });
  return { reached, markReached, release, opened };
}

/**
 * The real worker-pool executor, with two seams a test can hold open — a run's
 * finalize dispatch and a run's release — plus a view of in-flight file batches.
 * Nothing about dispatch itself changes: every call still reaches the worker.
 */
export class ObservedEnrichmentExecutor extends WorkerPoolEnrichmentExecutor {
  private nextFinalizeHold?: CompletionHoldControl;
  private readonly releaseHoldsByRunId = new Map<string, CompletionHoldControl>();
  private readonly issuedHolds: CompletionHoldControl[] = [];
  private readonly fileBatches = new Set<Promise<unknown>>();

  constructor(private readonly events: LifecycleEvent[]) {
    // One thread: collection affinity pins every stateful call to it anyway.
    super(1, WORKER_PATH);
  }

  /** Hold the next `runFinalize` dispatch before it reaches the worker. */
  holdNextFinalize(): CompletionHold {
    const hold = completionHold();
    this.issuedHolds.push(hold);
    this.nextFinalizeHold = hold;
    return hold;
  }

  /** Hold `run`'s `releaseRun` before it reaches the worker. */
  holdRelease(run: EnrichmentRunHandle): CompletionHold {
    const hold = completionHold();
    this.issuedHolds.push(hold);
    this.releaseHoldsByRunId.set(run.runId, hold);
    return hold;
  }

  /** Let every hold go — teardown's guard against a test that failed while holding one. */
  releaseHolds(): void {
    this.nextFinalizeHold = undefined;
    this.releaseHoldsByRunId.clear();
    for (const hold of this.issuedHolds) hold.release();
  }

  /** Settles once every file batch dispatched so far has come back from the worker. */
  async fileBatchesSettled(): Promise<void> {
    await Promise.allSettled([...this.fileBatches]);
  }

  override async runFileBatch(
    ...args: Parameters<WorkerPoolEnrichmentExecutor["runFileBatch"]>
  ): ReturnType<WorkerPoolEnrichmentExecutor["runFileBatch"]> {
    const dispatch = super.runFileBatch(...args);
    this.fileBatches.add(dispatch);
    return dispatch;
  }

  override async runFinalize(
    ...args: Parameters<WorkerPoolEnrichmentExecutor["runFinalize"]>
  ): ReturnType<WorkerPoolEnrichmentExecutor["runFinalize"]> {
    const hold = this.nextFinalizeHold;
    this.nextFinalizeHold = undefined;
    if (hold) {
      hold.markReached();
      await hold.opened;
    }
    return super.runFinalize(...args);
  }

  override async releaseRun(providers: EnrichmentProvider[], run: EnrichmentRunHandle): Promise<void> {
    const hold = this.releaseHoldsByRunId.get(run.runId);
    if (hold) {
      this.releaseHoldsByRunId.delete(run.runId);
      hold.markReached();
      await hold.opened;
    }
    this.events.push({ kind: "release", runId: run.runId, phase: "start" });
    await super.releaseRun(providers, run);
    this.events.push({ kind: "release", runId: run.runId, phase: "end" });
  }
}

/** The daemon's full op table minus `ops` — a real daemon standing in for one from an older build. */
export function daemonOpsWithout(...ops: DaemonOp[]): DaemonOpCommandTable {
  return Object.fromEntries(Object.entries(DAEMON_OP_COMMANDS).filter(([op]) => !ops.includes(op as DaemonOp)));
}

export interface CodegraphFixtureOptions {
  /** The daemon's op table — trim it with `daemonOpsWithout` to stand in for an older build. */
  daemonOpCommands?: DaemonOpCommandTable;
}

/** Repo fixture + daemon + the main-thread codegraph provider, all under one temp root. */
interface CodegraphFixture {
  root: string;
  repoRoot: string;
  daemonPaths: CodegraphDaemonPaths;
  mainPool: GraphDbClientPool;
  provider: CodegraphEnrichmentProvider;
  close: () => Promise<void>;
}

async function startCodegraphFixture(options: CodegraphFixtureOptions): Promise<CodegraphFixture> {
  if (!existsSync(WORKER_PATH)) {
    throw new Error(`enrichment lifecycle harness needs the compiled worker at ${WORKER_PATH} — run npm run build`);
  }
  // Short prefix: the keyed daemon socket (bd tea-rags-mcp-42hno) must stay
  // inside the macOS 104-byte unix-socket path limit.
  const root = mkdtempSync(join(tmpdir(), "p7-lc-"));
  const repoRoot = join(root, "repo");
  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(dirname(join(repoRoot, relPath)), { recursive: true });
    writeFileSync(join(repoRoot, relPath), content);
  }

  const dataRoot = join(root, "data");
  const daemonPaths = getDaemonPaths(join(root, "d"));
  mkdirSync(daemonPaths.storageDir, { recursive: true });
  const daemon = await runDaemon({
    rootDir: dataRoot,
    paths: daemonPaths,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    buildFingerprint: "p7-lifecycle-daemon",
    ...(options.daemonOpCommands ? { opCommands: options.daemonOpCommands } : {}),
    // In-process daemon: a drain must never exit the test runner.
    exit: () => undefined,
  });

  // The descriptor `wireCodegraph` ships, pointed at this test's daemon and data root.
  const workerConfig: CodegraphWorkerConfig = {
    languageModulePath: LANGUAGE_MODULE,
    migrationsModulePath: pathToFileURL(MIGRATIONS_MODULE).href,
    daemonSocketPath: daemonPaths.socketPath,
    rootDir: dataRoot,
  };
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: CODEGRAPH_FACTORY_MODULE,
    providerFactoryExport: "createCodegraphEnrichmentProvider",
    dispatch: "collection-affinity",
    extractionFanout: true,
    serializableConfig: workerConfig,
  };
  // The main-thread instance: policy, the pass-1 aggregate read and cross-pass
  // extraction run here. Like the worker's, its pool has no respawn hook.
  const mainPool = new GraphDbClientPool({
    rootDir: dataRoot,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    applyMigrations: createDatabaseMigrationApplier(),
    daemonSocketPath: daemonPaths.socketPath,
  });
  const provider = new CodegraphEnrichmentProvider(
    {
      pool: mainPool,
      languageFactory: new LanguageFactory(),
      composer: new DefaultSymbolIdComposer(),
      collectSymbols,
    },
    descriptor,
  );

  return {
    root,
    repoRoot,
    daemonPaths,
    mainPool,
    provider,
    close: async () => {
      await mainPool.closeAll();
      await daemon.shutdown();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface EnrichmentLifecycleHarness {
  readonly collection: string;
  readonly repoRoot: string;
  readonly qdrant: RecordingQdrant;
  readonly executor: ObservedEnrichmentExecutor;
  readonly coordinator: EnrichmentCoordinator;
  /** Spec input shared by every run the test opens over the fixture. */
  runSpecInput: () => { absolutePath: string; collection: string; fileCount: number };
  /** The stored chunks as the chunk pipeline hands them to `onChunksStored`. */
  chunkItems: () => ChunkItem[];
  /** The stored chunks as the chunk pipeline hands them to `startChunkEnrichment`. */
  chunkMap: () => Map<string, ChunkLookupEntry[]>;
  /** `payload.enrichment` of the collection's metadata point. */
  readEnrichmentMarker: () => Promise<Record<string, any>>;
  /** The chunk overlay the codegraph builder derives for `symbolId` from the persisted graph. */
  chunkSignalsOf: (symbolId: string) => Promise<ChunkSignalOverlay>;
  /**
   * Every symbol the graph persisted, with its line range — read over a raw daemon
   * connection, so it works against a daemon a client pool would refuse.
   */
  persistedSymbols: () => Promise<SymbolDefinition[]>;
  close: () => Promise<void>;
}

/**
 * A coordinator over a collection whose chunks are already stored — the state a
 * reindex's run or a `--force-enrichments` recompute starts from.
 */
export async function startEnrichmentLifecycleHarness(
  options: CodegraphFixtureOptions = {},
): Promise<EnrichmentLifecycleHarness> {
  const fixture = await startCodegraphFixture(options);
  const { repoRoot, mainPool } = fixture;

  const collection = `code_p7_${Math.random().toString(36).slice(2, 10)}`;
  const qdrant = new RecordingQdrant();
  await qdrant.createCollection(collection, 384);
  await qdrant.addPoints(collection, [
    { id: INDEXING_METADATA_ID, vector: [], payload: { indexingComplete: true } },
    ...FIXTURE_CHUNKS.map((chunk) => ({
      id: chunk.id,
      vector: [],
      payload: {
        relativePath: chunk.relPath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        symbolId: chunk.symbolId,
        language: "typescript",
      },
    })),
  ]);

  const executor = new ObservedEnrichmentExecutor(qdrant.events);
  const coordinator = new EnrichmentCoordinator(qdrant as never, [fixture.provider], undefined, executor);
  const fileCount = new Set(FIXTURE_CHUNKS.map((chunk) => chunk.relPath)).size;

  return {
    collection,
    repoRoot,
    qdrant,
    executor,
    coordinator,
    runSpecInput: () => ({ absolutePath: repoRoot, collection, fileCount }),
    chunkItems: () =>
      FIXTURE_CHUNKS.map(
        (chunk) =>
          ({
            type: "upsert",
            chunkId: chunk.id,
            chunk: {
              content: "",
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              metadata: { filePath: join(repoRoot, chunk.relPath), symbolId: chunk.symbolId },
            },
          }) as unknown as ChunkItem,
      ),
    chunkMap: () => {
      const map = new Map<string, ChunkLookupEntry[]>();
      for (const chunk of FIXTURE_CHUNKS) {
        const entries = map.get(chunk.relPath) ?? [];
        entries.push({
          chunkId: chunk.id,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbolId: chunk.symbolId,
        });
        map.set(chunk.relPath, entries);
      }
      return map;
    },
    readEnrichmentMarker: async () => {
      const point = await qdrant.getPoint(collection, INDEXING_METADATA_ID);
      return (point?.payload?.enrichment ?? {}) as Record<string, any>;
    },
    chunkSignalsOf: async (symbolId) => {
      const { graphDb } = await mainPool.acquireReader(collection);
      const bulk = await graphDb.getChunkSignalsBulk();
      return buildCodegraphChunkSignals(bulk.get(symbolId));
    },
    persistedSymbols: async () => {
      const client = new DaemonGraphDbClient(fixture.daemonPaths.socketPath, collection);
      await client.init();
      try {
        return await client.listAllSymbols();
      } finally {
        await client.close();
      }
    },
    close: async () => {
      executor.releaseHolds();
      await coordinator.whenCompletionsSettled(collection);
      await executor.shutdown();
      await fixture.close();
    },
  };
}

export interface IngestLifecycleHarness {
  readonly repoRoot: string;
  readonly qdrant: RecordingQdrant;
  readonly executor: ObservedEnrichmentExecutor;
  /** The facade MCP `index_codebase` and the CLI worker reach `IndexingOps#run` through. */
  readonly ingest: IngestFacade;
  /** The single physical collection the index operations built (the alias target). */
  indexedCollection: () => Promise<string>;
  close: () => Promise<void>;
}

/**
 * A real `IngestFacade` — `IndexingOps`, both pipelines, the chunker pool and the
 * coordinator it builds — enriching through the harness's worker pool and daemon.
 */
export async function startIngestLifecycleHarness(
  options: CodegraphFixtureOptions = {},
): Promise<IngestLifecycleHarness> {
  const fixture = await startCodegraphFixture(options);
  const qdrant = new RecordingQdrant();
  const executor = new ObservedEnrichmentExecutor(qdrant.events);
  const ingest = new IngestFacade({
    qdrant: qdrant as never,
    embeddings: new MockEmbeddingProvider(),
    config: { ...defaultTestConfig(), supportedExtensions: [".ts"] },
    trajectoryConfig: defaultTrajectoryConfig(),
    enrichmentProviders: [fixture.provider],
    enrichmentExecutor: executor,
    snapshotDir: join(fixture.root, "snapshots"),
  } as never);

  return {
    repoRoot: fixture.repoRoot,
    qdrant,
    executor,
    ingest,
    indexedCollection: async () => {
      const [collection, ...others] = await qdrant.listCollections();
      if (!collection || others.length > 0) {
        throw new Error(`expected exactly one indexed collection, found ${[collection, ...others].join(", ")}`);
      }
      return collection;
    },
    close: async () => {
      executor.releaseHolds();
      await ingest.whenEnrichmentComplete();
      await executor.shutdown();
      await fixture.close();
    },
  };
}

/** One event-loop turn: every microtask queued so far — the in-memory Qdrant's included — has run. */
export async function eventLoopTurn(): Promise<void> {
  await new Promise<void>((settle) => {
    setImmediate(settle);
  });
}

/** Marker events for `key`, with their position in the event log. */
export function markerEvents(events: readonly LifecycleEvent[], key: string): { index: number; runId?: string }[] {
  return events.flatMap((event, index) =>
    event.kind === "marker" && event.key === key ? [{ index, runId: event.runId }] : [],
  );
}

/** The codegraph chunk writes a run stamped on `pointId` — a run's writes carry its `startedAt`. */
export function chunkSignalWritesOf(
  writes: readonly ChunkSignalsWrite[],
  pointId: string,
  runStartedAt: string,
): Record<string, unknown>[] {
  return writes
    .filter((write) => write.points.includes(pointId) && write.payload.enrichedAt === runStartedAt)
    .map((write) => write.payload);
}
