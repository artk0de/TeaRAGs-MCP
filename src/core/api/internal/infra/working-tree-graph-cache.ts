/**
 * WorkingTreeGraphCache (bd tea-rags-mcp-xi2r9, WTO-7) — schedules and keeps
 * the working tree's codegraph: the PRODUCTION incremental codegraph run over
 * the tree's delta, applied to a private snapshot of the base graph, built in a
 * child process (`WorkingTreeGraphProcessBuilder`) and published on disk.
 *
 * It lives in `api/internal` because it bridges three layers that cannot see
 * each other: the base graph's pool (`adapters/duckdb`), the tree build
 * (`domains/trajectory/codegraph/working-tree`), and the overlay / graph
 * readers that consume it through the `WorkingTreeGraphSource` contract port.
 *
 * Layout under `<appData>/working-tree/<collection>/graph/` (`<collection>` is
 * the base index's LOGICAL name, the same segment the chunk store uses, so a
 * version bump does not orphan the directory):
 *
 * - `snapshots/<physical>-<version>.duckdb` — one self-contained copy of the
 *   base graph per base version, taken through the session that owns the live
 *   file (`exportSnapshot`). The version is {@link baseGraphVersion}; every
 *   tree over one base state shares one snapshot. The graph file itself is
 *   named by the PHYSICAL collection (`<name>_vN`) — the alias would address a
 *   shadow file.
 * - `trees/<key>/` — one published tree graph. The key is CONTENT-based
 *   ({@link treeGraphKey}): the tree root, the physical collection, the base
 *   version, and a digest of the delta's bytes — sorted `(relativePath, sha256
 *   of content)` of the changed files plus the sorted deleted paths. A file
 *   reverted to identical bytes therefore lands on the graph already published
 *   for those bytes; the delta reader's fingerprint (which carries mtimes) does
 *   not enter the key. Holds `codegraph/<physical>.duckdb` and
 *   `tree-graph.meta.json` (tree root, publish time, db path). Built into
 *   `<key>.staging-<pid>-<rand>` and renamed into place, so no reader — in this
 *   or a concurrent server — ever opens a half-built graph; a key dir that
 *   already exists when the build ends belongs to a process that won the race,
 *   and the staging copy is discarded.
 *
 * Scheduling: single-flight per key in-process; a caller waits at most its
 * `waitMs` and is told `building` past it while the build continues (the next
 * call joins the same promise) — unless the build's outcome arrived in the very
 * turn the wait lapsed, which is then the answer; a finished failure is
 * remembered per key for `failureBackoffMs`, so a tree the build cannot handle
 * does not fork a child per request. Every outcome but `built` is a product
 * answer — the reader degrades to the base graph — so `graphFor` never rejects.
 *
 * Retention runs after every publish (for that tree's graphs and that
 * collection's snapshots) and on the chunk store's cadence (for everything):
 * see {@link retiredTreeGraphs} and {@link WorkingTreeGraphCache#retireSnapshotsOf}.
 * Across trees (live round-4 B2): a graph no process served for
 * {@link WORKING_TREE_GRAPH_IDLE_RETENTION_MS} goes, as does a snapshot no
 * build used for as long, and each collection's graphs fit
 * {@link WORKING_TREE_GRAPH_CAP_BYTES}, least-recently-active first. The
 * periodic sweep never runs at start: the first waits
 * {@link WORKING_TREE_GRAPH_SWEEP_DELAY_MS} on an unref'd timer, longer than a
 * one-shot process lives, and `sweepIfDue` skips when any process started one
 * within the interval (`.graph-sweep-stamp.json` under the root).
 * A process that exits mid-build kills its build children and removes its
 * staging dirs synchronously; a staging dir whose owner pid is dead is swept at
 * once.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs, rmSync } from "node:fs";
import { join, relative } from "node:path";

import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type {
  WorkingTreeGraphRequest,
  WorkingTreeGraphSource,
  WorkingTreeGraphState,
} from "../../../contracts/types/working-tree.js";
import {
  WORKING_TREE_CHUNK_RETENTION_MS,
  WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS,
} from "../../../domains/explore/working-tree/index.js";
import type {
  WorkingTreeGraphBuildBudget,
  WorkingTreeGraphBuildInput,
  WorkingTreeGraphBuildOutcome,
  WorkingTreeGraphProviderConfig,
} from "../../../domains/trajectory/codegraph/working-tree/index.js";
import { physicalCollectionNamesListedByStorage, resolvePhysicalCollection } from "../../../infra/collection-name.js";

/** The reason a caller gets when its wait lapsed and the build is still running. */
export const WORKING_TREE_GRAPH_BUILDING_REASON = "building";

/** How long a finished failure answers for its key before the build is tried again. */
export const WORKING_TREE_GRAPH_FAILURE_BACKOFF_MS = 60_000;

/** Default wall-clock budget of one tree build (spec: graph tools wait up to 120 s). */
export const WORKING_TREE_GRAPH_BUILD_TIMEOUT_MS = 120_000;

/** A staging dir or a snapshot temp file older than this is a dead write. */
const ABANDONED_WRITE_GRACE_MS = 3_600_000;
/**
 * How long a SUPERSEDED snapshot or tree graph survives its supersession.
 * Retention is per process but the files are shared: a build in another server
 * may have just picked an older snapshot (it is cloned when the child starts),
 * and a reader there may hold an older tree graph open. Ten minutes covers a
 * child's clone and any graph read with a wide margin; a build that still loses
 * its snapshot is retried once (`WorkingTreeGraphCache#publishOnce`).
 */
export const WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS = 10 * 60_000;
/**
 * At most this many graphs per tree (and snapshots per collection — the live
 * one and one superseded) outlive a publish, whatever their age, unless a
 * reader or build of THIS process holds one. A burst of edits otherwise piles
 * up one graph per edit for the whole grace.
 */
export const WORKING_TREE_GRAPH_KEPT_PER_TREE = 2;
/**
 * A graph no process served for this long goes, whatever its tree (live
 * round-4 B2) — the chunk store's read-idle retention. A snapshot no build used
 * for as long goes too; the next build re-exports it.
 */
export const WORKING_TREE_GRAPH_IDLE_RETENTION_MS = WORKING_TREE_CHUNK_RETENTION_MS;
/** The bytes one collection's tree graphs may hold; the least recently active go first beyond it. */
export const WORKING_TREE_GRAPH_CAP_BYTES = 2 * 1024 ** 3;
/** The periodic sweep's first run waits this long — the chunk store's delay. */
export const WORKING_TREE_GRAPH_SWEEP_DELAY_MS = 2 * 60_000;
/** …and then runs this often, across every process sharing the root (the stamp). */
export const WORKING_TREE_GRAPH_SWEEP_INTERVAL_MS = WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS;
/**
 * A graph served this long after its last recorded activity has its `servedAt`
 * written again, so the idle rule measures from the last serve without a meta
 * write per request.
 */
const SERVED_REFRESH_MS = 3_600_000;
/** The cross-process throttle: a dot-file in the root, never a collection directory. */
const SWEEP_STAMP_FILE = ".graph-sweep-stamp.json";
const META_FILE = "tree-graph.meta.json";
const STAGING_MARKER = ".staging-";
/** `<key>.staging-<pid>-<rand>`: the owner pid is in the name. */
const STAGING_OWNER = /\.staging-(\d+)-[0-9a-f]+$/;
/** `GraphDbClient#exportSnapshot` writes `<target>.snapshot-tmp` before its rename. */
const SNAPSHOT_TEMP_MARKER = ".snapshot-tmp";
const SNAPSHOT_FILE = /^(.+)-([0-9a-f]{16})\.duckdb$/;
/** Same rule as the chunk store: a collection name is one path segment, never an escape from the root. */
const COLLECTION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Content-hash memo entries kept before the oldest is dropped (the delta itself is capped at 200 files). */
const CONTENT_HASH_MEMO_LIMIT = 4096;
/** The digest a changed path that is not a readable regular file contributes. */
const ABSENT_CONTENT = "absent";

/** The slice of `GraphDbClientPool` the cache reads the base graph through. */
export interface WorkingTreeGraphBasePool {
  hasDatabase: (physicalCollectionName: PhysicalCollectionName) => boolean;
  pathFor: (physicalCollectionName: PhysicalCollectionName) => string;
  exportSnapshot: (physicalCollectionName: PhysicalCollectionName, targetPath: string) => Promise<void>;
  /** Whether a reader of this process holds the graph file open (`GraphDbClientPool#isFileReaderOpen`). */
  isFileReaderOpen?: (dbPath: string) => boolean;
}

/** What a tree build needs from the running codegraph: the base pool and the provider config the enrichment worker gets. */
export interface WorkingTreeGraphCodegraphRuntime {
  pool: WorkingTreeGraphBasePool;
  providerConfig: WorkingTreeGraphProviderConfig;
}

/** `WorkingTreeGraphProcessBuilder`'s surface; a test hands a fake. */
export interface WorkingTreeGraphBuilder {
  build: (
    input: WorkingTreeGraphBuildInput,
    budget: WorkingTreeGraphBuildBudget,
  ) => Promise<WorkingTreeGraphBuildOutcome>;
  /** Kill every build child still running, synchronously — the process is exiting. */
  killInFlight?: () => void;
}

/**
 * Where the cache hooks the process's end. `register` runs `onExit`
 * synchronously when the process exits or is signalled and returns the
 * unregister; the cache holds a registration only while a build runs.
 */
export interface WorkingTreeGraphExitHooks {
  register: (onExit: () => void) => () => void;
}

const EXIT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * `exit`, `beforeExit`, `SIGINT`, `SIGTERM`. A signal listener alone would
 * swallow the signal's default (terminate), so when it is the only listener it
 * steps aside and re-raises the signal; beside the server's own shutdown
 * listeners it only cleans up and leaves the exit to them.
 */
export const processExitHooks: WorkingTreeGraphExitHooks = {
  register: (onExit) => {
    const runOnce = (): void => {
      try {
        onExit();
      } catch {
        // The process is going away; nothing to report to.
      }
    };
    const onSignal = (signal: NodeJS.Signals): void => {
      runOnce();
      if (process.listenerCount(signal) === 1) {
        unregister();
        process.kill(process.pid, signal);
      }
    };
    const unregister = (): void => {
      process.removeListener("exit", runOnce);
      process.removeListener("beforeExit", runOnce);
      for (const signal of EXIT_SIGNALS) process.removeListener(signal, onSignal);
    };
    process.once("exit", runOnce);
    process.once("beforeExit", runOnce);
    for (const signal of EXIT_SIGNALS) process.on(signal, onSignal);
    return unregister;
  },
};

export interface WorkingTreeGraphCacheDeps {
  /** `<appData>/working-tree` — shared with the chunk store; the cache only writes under `<collection>/graph/`. */
  rootDir: string;
  /**
   * Late-bound codegraph runtime, `undefined` while codegraph is off. Late
   * because the overlay that warms the cache is composed before the codegraph
   * pool exists (the pool's GraphFacade takes the overlay).
   */
  codegraph: () => WorkingTreeGraphCodegraphRuntime | undefined;
  /** Alias → active physical collection, as `GraphFacade` resolves it; absent or failing, the name is used verbatim. */
  resolveActiveCollection?: (collectionName: string) => Promise<PhysicalCollectionName>;
  builder: WorkingTreeGraphBuilder;
  budget: WorkingTreeGraphBuildBudget;
  failureBackoffMs?: number;
  now?: () => number;
  /** Defaults to {@link processExitHooks}. */
  exitHooks?: WorkingTreeGraphExitHooks;
  /** Per-collection byte cap of the tree graphs; defaults to {@link WORKING_TREE_GRAPH_CAP_BYTES}. */
  capBytes?: number;
}

export interface WorkingTreeGraphSweepOptions {
  /** How long after any process's sweep started `sweepIfDue` skips. */
  intervalMs?: number;
}

export interface WorkingTreeGraphSweepSchedule {
  /** Delay before the first sweep — longer than a one-shot process lives. */
  initialDelayMs?: number;
  intervalMs?: number;
}

export interface WorkingTreeGraphCacheSweep {
  evictedGraphs: number;
  evictedSnapshots: number;
  evictedStaging: number;
  keptGraphs: number;
}

/** The commit record of a published tree graph — written into staging before the rename. */
interface WorkingTreeGraphMeta {
  treeRoot: string;
  publishedAt: number;
  /**
   * When a process last served this graph as the tree's CURRENT one after a
   * different graph — a revert to bytes already built — or served it at least
   * {@link SERVED_REFRESH_MS} after its last recorded activity. Retention
   * orders a tree's graphs by `max(publishedAt, servedAt)`: a graph re-served
   * is the tree's newest again, not its oldest; and the idle rule measures
   * from it. Absent until first re-served.
   */
  servedAt?: number;
  physicalCollectionName: string;
  /** The graph file, relative to the key dir. */
  dbRelPath: string;
}

/** One resolved request: everything the key and the build depend on. */
interface WorkingTreeGraphJob {
  request: WorkingTreeGraphRequest;
  runtime: WorkingTreeGraphCodegraphRuntime;
  physical: PhysicalCollectionName;
  baseVersion: string;
  /** Digest of the delta's bytes — see {@link treeGraphKey}. */
  deltaDigest: string;
  key: string;
  graphDir: string;
}

/** A build in flight for one key, and whether its builder has answered yet. */
interface WorkingTreeGraphInflightBuild {
  promise: Promise<WorkingTreeGraphState>;
  /** The builder returned (or threw); what is left is publishing or cleanup. */
  outcomeArrived: boolean;
}

/** One build attempt's end: published, or failed — and whether its snapshot vanished under it. */
type WorkingTreeGraphAttempt =
  | { kind: "published"; state: WorkingTreeGraphState }
  | { kind: "failed"; state: WorkingTreeGraphState; snapshotVanished: boolean };

/** One published tree graph, as retention sees it. */
interface PublishedTreeGraph {
  dir: string;
  dbPath: string;
  /** When the graph last became its tree's current one, or was last served — {@link activeAtOf}. */
  activeAt: number;
}

/** `max(publishedAt, servedAt)`: a graph re-served after another is the tree's newest again. */
function activeAtOf(meta: WorkingTreeGraphMeta): number {
  return Math.max(meta.publishedAt, meta.servedAt ?? 0);
}

const unavailable = (reason: string): WorkingTreeGraphState => ({ kind: "unavailable", reason });

export class WorkingTreeGraphCache implements WorkingTreeGraphSource {
  private readonly inflight = new Map<string, WorkingTreeGraphInflightBuild>();
  private readonly failures = new Map<string, { state: WorkingTreeGraphState; until: number }>();
  private readonly snapshotExports = new Map<string, Promise<void>>();
  /** Snapshots a running build of THIS process reads — never removed under it. */
  private readonly snapshotsInUse = new Map<string, number>();
  /** Staging dirs THIS process is building into — never swept under it, removed at exit. */
  private readonly stagingInUse = new Set<string>();
  /** `(path, size, mtime, ctime, inode)` → content sha256 of a changed file; see {@link contentHashOf}. */
  private readonly contentHashes = new Map<string, { stamp: string; sha: string }>();
  /**
   * Tree root → the key of the graph this process last served or published for
   * it, and the activity time its meta records as far as this process knows;
   * see {@link markServed}.
   */
  private readonly servedKeyByTree = new Map<string, { key: string; recordedAt: number }>();
  private unregisterExitHook: (() => void) | undefined;
  private readonly now: () => number;
  private readonly failureBackoffMs: number;
  private readonly exitHooks: WorkingTreeGraphExitHooks;
  private readonly capBytes: number;

  constructor(private readonly deps: WorkingTreeGraphCacheDeps) {
    this.now = deps.now ?? Date.now;
    this.failureBackoffMs = deps.failureBackoffMs ?? WORKING_TREE_GRAPH_FAILURE_BACKOFF_MS;
    this.exitHooks = deps.exitHooks ?? processExitHooks;
    this.capBytes = deps.capBytes ?? WORKING_TREE_GRAPH_CAP_BYTES;
  }

  async graphFor(request: WorkingTreeGraphRequest, waitMs: number): Promise<WorkingTreeGraphState> {
    const tracker: { build?: WorkingTreeGraphInflightBuild } = {};
    const work = this.resolve(request, tracker).catch((err: unknown) =>
      unavailable(`tree graph cache error: ${errorMessage(err)}`),
    );
    let timer: NodeJS.Timeout | undefined;
    const lapse = new Promise<WorkingTreeGraphState>((resolve) => {
      timer = setTimeout(
        () => {
          // Let whatever else is due in this turn run first: a build whose
          // outcome arrived alongside the lapse is only publishing or cleaning
          // up, and its answer — a timeout's reason, say — beats `building`.
          setImmediate(() => {
            const { build } = tracker;
            resolve(build?.outcomeArrived ? build.promise : unavailable(WORKING_TREE_GRAPH_BUILDING_REASON));
          }).unref?.();
        },
        Math.max(0, waitMs),
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([work, lapse]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Retention, run with the chunk store's cadence: a dead tree's graphs go at
   * once; per tree the superseded and the idle graphs go per
   * {@link retiredTreeGraphs}; then each collection's graphs fit the byte cap,
   * least-recently-active first; a snapshot whose base version is no longer the
   * live one goes per {@link retireSnapshotsOf}, the live one once unused for
   * the idle retention; staging dirs whose owner process is dead go at once,
   * others and snapshot temp files once older than an hour. A graph a reader
   * of this process holds open and a snapshot a build of this process reads
   * are never removed. Nothing outside `<rootDir>/<collection>/graph/` is
   * touched.
   */
  async sweep(at: number = this.now()): Promise<WorkingTreeGraphCacheSweep> {
    const result: WorkingTreeGraphCacheSweep = {
      evictedGraphs: 0,
      evictedSnapshots: 0,
      evictedStaging: 0,
      keptGraphs: 0,
    };
    for (const collection of await listDir(this.deps.rootDir)) {
      if (!collection.isDirectory || !COLLECTION_SEGMENT.test(collection.name)) continue;
      const graphDir = join(this.deps.rootDir, collection.name, "graph");
      await this.sweepTrees(join(graphDir, "trees"), at, result);
      await this.sweepSnapshots(join(graphDir, "snapshots"), at, result);
      await removeIfEmpty(join(graphDir, "trees"));
      await removeIfEmpty(join(graphDir, "snapshots"));
      await removeIfEmpty(graphDir);
    }
    return result;
  }

  /**
   * {@link sweep}, unless a process sharing this root started one within
   * `intervalMs` (the stamp is written at the START, so a concurrent process
   * skips instead of sweeping alongside). Undefined when skipped, and when the
   * root does not exist — no root is created for a stamp.
   */
  async sweepIfDue(
    at: number = this.now(),
    options: WorkingTreeGraphSweepOptions = {},
  ): Promise<WorkingTreeGraphCacheSweep | undefined> {
    const intervalMs = options.intervalMs ?? WORKING_TREE_GRAPH_SWEEP_INTERVAL_MS;
    if (!(await isDirectory(this.deps.rootDir))) return undefined;
    const stampPath = join(this.deps.rootDir, SWEEP_STAMP_FILE);
    const sweptAt = await readSweepStamp(stampPath);
    if (sweptAt !== undefined && sweptAt <= at && at - sweptAt < intervalMs) return undefined;
    const temp = `${stampPath}.${String(process.pid)}-${randomBytes(4).toString("hex")}`;
    await fs.writeFile(temp, JSON.stringify({ sweptAt: at }));
    await fs.rename(temp, stampPath);
    return this.sweep(at);
  }

  /**
   * The process is exiting: kill the build children still running and remove
   * this process's staging dirs, synchronously — an `exit` listener cannot
   * await. A build promise still pending sees its child die and settles as a
   * failure if the process lives on.
   */
  abandonInFlightBuilds(): void {
    try {
      this.deps.builder.killInFlight?.();
    } catch {
      // A child that cannot be signalled is gone already.
    }
    for (const staging of this.stagingInUse) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        // The sweep of the next process collects it: its owner pid is dead.
      }
    }
  }

  private async resolve(
    request: WorkingTreeGraphRequest,
    tracker: { build?: WorkingTreeGraphInflightBuild },
  ): Promise<WorkingTreeGraphState> {
    if (request.changed.length === 0 && request.deleted.length === 0) {
      return unavailable("clean working tree — the base graph is the tree's graph");
    }
    const runtime = this.deps.codegraph();
    if (!runtime) return unavailable("codegraph is disabled");
    const { collectionName } = request.tree.baseIndex;
    if (!COLLECTION_SEGMENT.test(collectionName)) {
      return unavailable(`collection name ${JSON.stringify(collectionName)} is not a storage path segment`);
    }
    const physical = await this.resolvePhysical(collectionName);
    if (!runtime.pool.hasDatabase(physical)) return unavailable(`no base codegraph for ${physical}`);
    const baseVersion = await baseGraphVersion(runtime.pool.pathFor(physical));
    if (!baseVersion) return unavailable(`base codegraph for ${physical} vanished`);

    const deltaDigest = await this.deltaContentDigest(request);
    const key = treeGraphKey(request.tree.root, physical, baseVersion, deltaDigest);
    const failure = this.failures.get(key);
    if (failure) {
      if (failure.until > this.now()) return failure.state;
      this.failures.delete(key);
    }
    let build = this.inflight.get(key);
    if (!build) {
      const job: WorkingTreeGraphJob = {
        request,
        runtime,
        physical,
        baseVersion,
        deltaDigest,
        key,
        graphDir: join(this.deps.rootDir, collectionName, "graph"),
      };
      const entry: WorkingTreeGraphInflightBuild = {
        promise: Promise.resolve(unavailable(WORKING_TREE_GRAPH_BUILDING_REASON)),
        outcomeArrived: false,
      };
      entry.promise = this.publishOnce(job, entry).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, entry);
      build = entry;
    }
    tracker.build = build;
    return build.promise;
  }

  private async resolvePhysical(collectionName: string): Promise<PhysicalCollectionName> {
    const fallback = (): PhysicalCollectionName => resolvePhysicalCollection(collectionName, []);
    if (!this.deps.resolveActiveCollection) return fallback();
    return this.deps.resolveActiveCollection(collectionName).catch(fallback);
  }

  /**
   * The delta's bytes as one digest: sorted `(relativePath, content sha256)` of
   * the changed files and the sorted deleted paths. Only the changed files are
   * read (the overlay caps them at 200), each through {@link contentHashOf}.
   */
  private async deltaContentDigest(request: WorkingTreeGraphRequest): Promise<string> {
    const changed = [...new Set(request.changed)].sort();
    const files = await Promise.all(
      changed.map(async (relPath) => [relPath, await this.contentHashOf(join(request.tree.root, relPath))]),
    );
    const deleted = [...new Set(request.deleted)].sort();
    return createHash("sha256")
      .update(JSON.stringify([files, deleted]))
      .digest("hex");
  }

  /**
   * One file's content sha256, memoized by `(size, mtime, ctime, inode)` so a
   * delta re-asked on every graph call re-reads only the files that moved. A
   * path that is not a readable regular file contributes {@link ABSENT_CONTENT}.
   */
  private async contentHashOf(path: string): Promise<string> {
    const stat = await fs.stat(path).catch(() => undefined);
    if (!stat?.isFile()) return ABSENT_CONTENT;
    const stamp = `${String(stat.size)}:${String(stat.mtimeMs)}:${String(stat.ctimeMs)}:${String(stat.ino)}`;
    const memo = this.contentHashes.get(path);
    if (memo?.stamp === stamp) return memo.sha;
    const content = await fs.readFile(path).catch(() => undefined);
    if (!content) return ABSENT_CONTENT;
    const sha = createHash("sha256").update(content).digest("hex");
    this.contentHashes.delete(path);
    this.contentHashes.set(path, { stamp, sha });
    if (this.contentHashes.size > CONTENT_HASH_MEMO_LIMIT) {
      const oldest = this.contentHashes.keys().next().value;
      if (oldest !== undefined) this.contentHashes.delete(oldest);
    }
    return sha;
  }

  /**
   * The published graph of the job's key, building it first when no process
   * has. A build whose snapshot is gone afterwards lost it to another server's
   * sweep (it judged the version superseded, or the grace ran out under a slow
   * clone): the base version is re-read, its snapshot re-exported, and the
   * build retried ONCE before the failure is remembered. Detection is the
   * snapshot path's absence, never the child's message text.
   */
  private async publishOnce(
    job: WorkingTreeGraphJob,
    entry: WorkingTreeGraphInflightBuild,
  ): Promise<WorkingTreeGraphState> {
    const first = await this.buildAndPublish(job, entry);
    if (first.kind === "published") return first.state;
    if (!first.snapshotVanished) return this.remember(job.key, first.state);

    const baseVersion = await baseGraphVersion(job.runtime.pool.pathFor(job.physical));
    if (!baseVersion) return this.remember(job.key, unavailable(`base codegraph for ${job.physical} vanished`));
    const retry: WorkingTreeGraphJob = {
      ...job,
      baseVersion,
      key: treeGraphKey(job.request.tree.root, job.physical, baseVersion, job.deltaDigest),
    };
    const joined = retry.key === job.key ? undefined : this.inflight.get(retry.key);
    if (joined) return joined.promise;
    const second = await this.buildAndPublish(retry, entry);
    if (second.kind === "published") return second.state;
    if (retry.key !== job.key) this.remember(retry.key, second.state);
    return this.remember(job.key, second.state);
  }

  /** One build attempt: publish the graph, or say how it failed and whether its snapshot vanished under it. */
  private async buildAndPublish(
    job: WorkingTreeGraphJob,
    entry: WorkingTreeGraphInflightBuild,
  ): Promise<WorkingTreeGraphAttempt> {
    const treesDir = join(job.graphDir, "trees");
    const keyDir = join(treesDir, job.key);
    const published = await readPublished(keyDir, job.physical);
    if (published) {
      await this.markServed(keyDir, job).catch(() => undefined);
      return { kind: "published", state: published };
    }

    const staging = join(
      treesDir,
      `${job.key}${STAGING_MARKER}${String(process.pid)}-${randomBytes(4).toString("hex")}`,
    );
    let snapshotPath: string | undefined;
    const failed = (state: WorkingTreeGraphState): WorkingTreeGraphAttempt => ({
      kind: "failed",
      state,
      snapshotVanished: snapshotPath !== undefined && !existsSync(snapshotPath),
    });
    entry.outcomeArrived = false;
    this.trackStaging(staging);
    try {
      snapshotPath = await this.ensureSnapshot(job);
      this.retainSnapshot(snapshotPath, 1);
      await fs.mkdir(staging, { recursive: true });
      let outcome: WorkingTreeGraphBuildOutcome;
      try {
        outcome = await this.deps.builder.build(
          {
            snapshotPath,
            outputRoot: staging,
            physicalCollectionName: job.physical,
            treeRoot: job.request.tree.root,
            changedRelPaths: job.request.changed,
            deletedRelPaths: job.request.deleted,
            providerConfig: job.runtime.providerConfig,
          },
          this.deps.budget,
        );
      } finally {
        entry.outcomeArrived = true;
      }
      if (outcome.kind !== "built") return failed(unavailable(buildFailureReason(outcome)));

      const meta: WorkingTreeGraphMeta = {
        treeRoot: job.request.tree.root,
        publishedAt: this.now(),
        physicalCollectionName: job.physical,
        dbRelPath: relative(staging, outcome.graph.dbPath),
      };
      await fs.writeFile(join(staging, META_FILE), JSON.stringify(meta));
      if (!existsSync(keyDir)) {
        try {
          await fs.rename(staging, keyDir);
        } catch (err) {
          // A concurrent server published the same key between the check and the rename.
          if (!isDirectoryTaken(err)) throw err;
        }
      }
      const state = await readPublished(keyDir, job.physical);
      if (!state) return failed(unavailable(`tree graph ${keyDir} was published without a readable graph`));
      this.servedKeyByTree.set(job.request.tree.root, { key: job.key, recordedAt: meta.publishedAt });
      await this.retireAfterPublish(job).catch(() => undefined);
      return { kind: "published", state };
    } catch (err) {
      return failed(unavailable(`tree graph build failed: ${errorMessage(err)}`));
    } finally {
      if (snapshotPath) this.retainSnapshot(snapshotPath, -1);
      this.untrackStaging(staging);
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * A published graph is served for its tree. When it is not the graph this
   * process last served for that tree — the tree went back to bytes already
   * built — its meta records `servedAt`, so retention treats it as the tree's
   * newest graph again. Serving the same graph again writes nothing until
   * {@link SERVED_REFRESH_MS} after the activity its meta records, then
   * `servedAt` moves, so the idle rule never evicts a graph still in use
   * (live round-4 B2). The meta is replaced by rename, never rewritten in
   * place: a concurrent reader sees the old record or the new one.
   */
  private async markServed(keyDir: string, job: WorkingTreeGraphJob): Promise<void> {
    const treeRoot = job.request.tree.root;
    const now = this.now();
    const served = this.servedKeyByTree.get(treeRoot);
    if (served?.key === job.key && now - served.recordedAt < SERVED_REFRESH_MS) return;
    const meta = await readMeta(keyDir);
    if (!meta) return;
    this.servedKeyByTree.set(treeRoot, { key: job.key, recordedAt: now });
    const temp = join(keyDir, `${META_FILE}.${String(process.pid)}-${randomBytes(4).toString("hex")}`);
    await fs.writeFile(temp, JSON.stringify({ ...meta, servedAt: now } satisfies WorkingTreeGraphMeta));
    await fs.rename(temp, join(keyDir, META_FILE)).catch(async (err: unknown) => {
      await fs.rm(temp, { force: true });
      throw err;
    });
  }

  /** A staging dir this process builds into; the exit hook is held while there is one. */
  private trackStaging(staging: string): void {
    this.stagingInUse.add(staging);
    this.unregisterExitHook ??= this.exitHooks.register(() => {
      this.abandonInFlightBuilds();
    });
  }

  private untrackStaging(staging: string): void {
    this.stagingInUse.delete(staging);
    if (this.stagingInUse.size > 0) return;
    this.unregisterExitHook?.();
    this.unregisterExitHook = undefined;
  }

  /**
   * After a publish: the published tree's superseded graphs and the
   * collection's superseded snapshots go per the retention rules, now — a burst
   * of edits would otherwise pile up until the periodic sweep.
   */
  private async retireAfterPublish(job: WorkingTreeGraphJob): Promise<void> {
    const treesDir = join(job.graphDir, "trees");
    const graphs: PublishedTreeGraph[] = [];
    for (const entry of await listDir(treesDir)) {
      if (!entry.isDirectory || entry.name.includes(STAGING_MARKER)) continue;
      const dir = join(treesDir, entry.name);
      const meta = await readMeta(dir);
      if (meta?.treeRoot !== job.request.tree.root) continue;
      graphs.push({ dir, dbPath: join(dir, meta.dbRelPath), activeAt: activeAtOf(meta) });
    }
    for (const graph of retiredTreeGraphs(graphs, this.now(), (dbPath) => this.isGraphInUse(dbPath))) {
      await fs.rm(graph.dir, { recursive: true, force: true });
    }
    await this.retireSnapshotsOf(join(job.graphDir, "snapshots"), job.physical, job.baseVersion, Date.now());
  }

  private isGraphInUse(dbPath: string): boolean {
    return this.deps.codegraph()?.pool.isFileReaderOpen?.(dbPath) ?? false;
  }

  private remember(key: string, state: WorkingTreeGraphState): WorkingTreeGraphState {
    this.failures.set(key, { state, until: this.now() + this.failureBackoffMs });
    return state;
  }

  /**
   * The snapshot of the job's base version, exported once (single-flight per
   * path). After a fresh export, the superseded versions of the same physical
   * graph are retired ({@link retireSnapshotsOf}).
   */
  private async ensureSnapshot(job: WorkingTreeGraphJob): Promise<string> {
    const snapshotsDir = join(job.graphDir, "snapshots");
    const snapshotPath = join(snapshotsDir, `${job.physical}-${job.baseVersion}.duckdb`);
    if (existsSync(snapshotPath)) {
      // Used: the idle rule measures a snapshot from its mtime (wall clock, like every file age here).
      const usedAt = new Date();
      await fs.utimes(snapshotPath, usedAt, usedAt).catch(() => undefined);
      return snapshotPath;
    }
    let exporting = this.snapshotExports.get(snapshotPath);
    if (!exporting) {
      exporting = (async () => {
        await fs.mkdir(snapshotsDir, { recursive: true });
        await job.runtime.pool.exportSnapshot(job.physical, snapshotPath);
        await this.retireSnapshotsOf(snapshotsDir, job.physical, job.baseVersion, Date.now());
      })().finally(() => {
        this.snapshotExports.delete(snapshotPath);
      });
      this.snapshotExports.set(snapshotPath, exporting);
    }
    await exporting;
    return snapshotPath;
  }

  /**
   * Retire the superseded snapshots of one physical graph: the live version's
   * snapshot always stays; of the others, newest first, the first stays until
   * it is older than the superseded grace (a build in another server may have
   * just picked it) and every further one goes at once — unless a build of THIS
   * process reads it. Returns how many were removed.
   */
  private async retireSnapshotsOf(
    snapshotsDir: string,
    physical: PhysicalCollectionName,
    liveVersion: string | undefined,
    at: number,
  ): Promise<number> {
    const superseded: { path: string; mtimeMs: number }[] = [];
    for (const entry of await listDir(snapshotsDir)) {
      const parsed = SNAPSHOT_FILE.exec(entry.name);
      if (parsed?.[1] !== physical || parsed[2] === liveVersion) continue;
      const path = join(snapshotsDir, entry.name);
      const stat = await fs.stat(path).catch(() => undefined);
      if (stat) superseded.push({ path, mtimeMs: stat.mtimeMs });
    }
    superseded.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let removed = 0;
    for (const [rank, snapshot] of superseded.entries()) {
      const pastGrace = at - snapshot.mtimeMs >= WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS;
      if (rank < WORKING_TREE_GRAPH_KEPT_PER_TREE - 1 && !pastGrace) continue;
      if (await this.removeSnapshot(snapshot.path)) removed++;
    }
    return removed;
  }

  private retainSnapshot(path: string, delta: 1 | -1): void {
    const count = (this.snapshotsInUse.get(path) ?? 0) + delta;
    if (count > 0) this.snapshotsInUse.set(path, count);
    else this.snapshotsInUse.delete(path);
  }

  /** Remove a snapshot (and any WAL beside it) unless a build of this process reads it. */
  private async removeSnapshot(path: string): Promise<boolean> {
    if (this.snapshotsInUse.has(path)) return false;
    await fs.rm(path, { force: true });
    await fs.rm(`${path}.wal`, { force: true });
    return true;
  }

  private async sweepTrees(treesDir: string, at: number, result: WorkingTreeGraphCacheSweep): Promise<void> {
    const kept: PublishedTreeGraph[] = [];
    const graphsPerTree = new Map<string, PublishedTreeGraph[]>();
    for (const entry of await listDir(treesDir)) {
      const dir = join(treesDir, entry.name);
      if (entry.name.includes(STAGING_MARKER)) {
        if (this.stagingInUse.has(dir)) continue;
        if (isOwnerDead(entry.name) || (await isOlderThanGrace(dir, at))) {
          await fs.rm(dir, { recursive: true, force: true });
          result.evictedStaging++;
        }
        continue;
      }
      if (!entry.isDirectory) continue;
      const meta = await readMeta(dir);
      if (!meta) {
        // A key dir is only ever renamed in complete; one without a readable
        // meta is damage, reclaimed once it cannot be a racing writer's.
        if (await isOlderThanGrace(dir, at)) {
          await fs.rm(dir, { recursive: true, force: true });
          result.evictedGraphs++;
        }
        continue;
      }
      if (!(await isDirectory(meta.treeRoot))) {
        await fs.rm(dir, { recursive: true, force: true });
        result.evictedGraphs++;
        continue;
      }
      const graphs = graphsPerTree.get(meta.treeRoot) ?? [];
      graphs.push({ dir, dbPath: join(dir, meta.dbRelPath), activeAt: activeAtOf(meta) });
      graphsPerTree.set(meta.treeRoot, graphs);
    }
    for (const graphs of graphsPerTree.values()) {
      const retired = new Set(retiredTreeGraphs(graphs, at, (dbPath) => this.isGraphInUse(dbPath)));
      for (const graph of graphs) {
        if (!retired.has(graph)) {
          kept.push(graph);
          continue;
        }
        await fs.rm(graph.dir, { recursive: true, force: true });
        result.evictedGraphs++;
      }
    }
    for (const graph of await this.overCapGraphs(kept)) {
      await fs.rm(graph.dir, { recursive: true, force: true });
      result.evictedGraphs++;
      kept.splice(kept.indexOf(graph), 1);
    }
    result.keptGraphs += kept.length;
  }

  /**
   * The graphs that go so one collection's graphs fit the byte cap: least
   * recently active first, never one a reader of this process holds open (it
   * still counts toward the total).
   */
  private async overCapGraphs(graphs: readonly PublishedTreeGraph[]): Promise<PublishedTreeGraph[]> {
    const sized = await Promise.all(graphs.map(async (graph) => ({ graph, bytes: await bytesUnder(graph.dir) })));
    let total = sized.reduce((sum, entry) => sum + entry.bytes, 0);
    const over: PublishedTreeGraph[] = [];
    for (const { graph, bytes } of sized.sort((a, b) => a.graph.activeAt - b.graph.activeAt)) {
      if (total <= this.capBytes) break;
      if (this.isGraphInUse(graph.dbPath)) continue;
      over.push(graph);
      total -= bytes;
    }
    return over;
  }

  private async sweepSnapshots(snapshotsDir: string, at: number, result: WorkingTreeGraphCacheSweep): Promise<void> {
    const runtime = this.deps.codegraph();
    const physicals = new Set<PhysicalCollectionName>();
    for (const entry of await listDir(snapshotsDir)) {
      const path = join(snapshotsDir, entry.name);
      if (entry.name.includes(SNAPSHOT_TEMP_MARKER)) {
        if (await isOlderThanGrace(path, at)) {
          await fs.rm(path, { recursive: true, force: true });
          result.evictedStaging++;
        }
        continue;
      }
      const parsed = SNAPSHOT_FILE.exec(entry.name);
      if (parsed) physicals.add(physicalCollectionNamesListedByStorage([parsed[1]])[0]);
    }
    for (const physical of physicals) {
      const live = runtime?.pool.hasDatabase(physical)
        ? await baseGraphVersion(runtime.pool.pathFor(physical))
        : undefined;
      result.evictedSnapshots += await this.retireSnapshotsOf(snapshotsDir, physical, live, at);
      if (live === undefined) continue;
      // The live version's snapshot, once no build used it for the idle retention.
      const livePath = join(snapshotsDir, `${physical}-${live}.duckdb`);
      if (
        (await isOlderThan(livePath, at, WORKING_TREE_GRAPH_IDLE_RETENTION_MS)) &&
        (await this.removeSnapshot(livePath))
      ) {
        result.evictedSnapshots++;
      }
    }
  }
}

/**
 * Which of one tree's published graphs retire at `at`. Ordered by when each
 * last became the tree's current graph ({@link activeAtOf} — published, or
 * re-served by a revert), the newest always stays. Each older graph was
 * SUPERSEDED when the next newer one became current, and its age is counted
 * from then — not from the newest's, which a burst of edits keeps forever
 * fresh. It goes once
 * superseded for {@link WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS} (a reader in
 * another server may hold it until then), or at once past the
 * {@link WORKING_TREE_GRAPH_KEPT_PER_TREE} newest. Any graph, the newest
 * included, goes once no process served it for
 * {@link WORKING_TREE_GRAPH_IDLE_RETENTION_MS} (live round-4 B2). Never while a
 * reader of this process holds it open.
 */
function retiredTreeGraphs(
  graphs: readonly PublishedTreeGraph[],
  at: number,
  isInUse: (dbPath: string) => boolean,
): PublishedTreeGraph[] {
  const newestFirst = [...graphs].sort((a, b) => b.activeAt - a.activeAt);
  const retired: PublishedTreeGraph[] = [];
  for (const [rank, graph] of newestFirst.entries()) {
    const idle = at - graph.activeAt >= WORKING_TREE_GRAPH_IDLE_RETENTION_MS;
    const overCap = rank >= WORKING_TREE_GRAPH_KEPT_PER_TREE;
    const pastGrace = rank > 0 && at - newestFirst[rank - 1].activeAt >= WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS;
    if ((idle || overCap || pastGrace) && !isInUse(graph.dbPath)) retired.push(graph);
  }
  return retired;
}

/**
 * Sweeps (if due) once `initialDelayMs` has passed and every `intervalMs`
 * after — the chunk store's schedule — on timers that do not hold the process
 * open: a one-shot process exits before the first, so a request never waits on
 * retention. Returns the stop.
 */
export function scheduleWorkingTreeGraphSweep(
  cache: Pick<WorkingTreeGraphCache, "sweepIfDue">,
  schedule: WorkingTreeGraphSweepSchedule = {},
): () => void {
  const intervalMs = schedule.intervalMs ?? WORKING_TREE_GRAPH_SWEEP_INTERVAL_MS;
  let stopped = false;
  const sweep = (): void => {
    if (stopped) return;
    void cache.sweepIfDue(undefined, { intervalMs }).catch(() => undefined);
  };
  let interval: ReturnType<typeof setInterval> | undefined;
  const first = setTimeout(() => {
    sweep();
    interval = setInterval(sweep, intervalMs);
    interval.unref?.();
  }, schedule.initialDelayMs ?? WORKING_TREE_GRAPH_SWEEP_DELAY_MS);
  first.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(interval);
  };
}

function buildFailureReason(outcome: Exclude<WorkingTreeGraphBuildOutcome, { kind: "built" }>): string {
  switch (outcome.kind) {
    case "failed":
      return `tree graph build failed: ${outcome.reason}`;
    case "timedOut":
      return `tree graph build timed out after ${String(outcome.timeoutMs)} ms`;
    case "heapExhausted":
      return `tree graph build exhausted its ${String(outcome.heapLimitMb)} MB heap`;
  }
}

/**
 * The base graph's version: a hash of `(size, mtimeMs)` of the `.duckdb` and
 * its `.wal`. `undefined` when the database file is gone.
 *
 * Why stat and not content: hashing a multi-hundred-MB graph per graph call is
 * the cost this key exists to avoid, and DuckDB moves at least one of the four
 * numbers on every committed write — a commit appends to the `.wal`, a
 * checkpoint rewrites the `.duckdb` and truncates or deletes the `.wal`, a
 * compaction renames a new file in.
 *
 * The contract this rests on: a READ never writes either file. Every read path
 * of the base graph honours it — the graph tools, the reports, `exportSnapshot`
 * (a `COPY FROM DATABASE` out of the live connection, no checkpoint) and
 * `review_changes`, whose per-review scratch tables are connection-scoped TEMP
 * tables (`DuckDbReviewEdgeStore`, bd tea-rags-mcp-xi2r9 D4). A read path that
 * wrote — a persistent scratch table, a CHECKPOINT on a read — would move the
 * version and orphan every tree graph and snapshot of the collection.
 */
async function baseGraphVersion(dbPath: string): Promise<string | undefined> {
  const db = await fs.stat(dbPath).catch(() => undefined);
  if (!db) return undefined;
  const wal = await fs.stat(`${dbPath}.wal`).catch(() => undefined);
  return createHash("sha256")
    .update(JSON.stringify([db.size, db.mtimeMs, wal?.size ?? -1, wal?.mtimeMs ?? -1]))
    .digest("hex")
    .slice(0, 16);
}

async function readMeta(keyDir: string): Promise<WorkingTreeGraphMeta | undefined> {
  try {
    const meta = JSON.parse(await fs.readFile(join(keyDir, META_FILE), "utf8")) as Partial<WorkingTreeGraphMeta>;
    return typeof meta.treeRoot === "string" &&
      typeof meta.publishedAt === "number" &&
      (meta.servedAt === undefined || typeof meta.servedAt === "number") &&
      typeof meta.physicalCollectionName === "string" &&
      typeof meta.dbRelPath === "string"
      ? (meta as WorkingTreeGraphMeta)
      : undefined;
  } catch {
    return undefined;
  }
}

async function readPublished(
  keyDir: string,
  physical: PhysicalCollectionName,
): Promise<WorkingTreeGraphState | undefined> {
  const meta = await readMeta(keyDir);
  if (!meta) return undefined;
  const dbPath = join(keyDir, meta.dbRelPath);
  return existsSync(dbPath) ? { kind: "built", dbPath, physicalCollectionName: physical } : undefined;
}

async function listDir(dir: string): Promise<{ name: string; isDirectory: boolean }[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
    }));
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  return (await fs.stat(path).catch(() => undefined))?.isDirectory() ?? false;
}

async function isOlderThanGrace(path: string, at: number): Promise<boolean> {
  return isOlderThan(path, at, ABANDONED_WRITE_GRACE_MS);
}

async function isOlderThan(path: string, at: number, ageMs: number): Promise<boolean> {
  const stat = await fs.stat(path).catch(() => undefined);
  return stat !== undefined && at - stat.mtimeMs >= ageMs;
}

/**
 * Whether the process a staging dir names as its owner is gone. This process
 * is never dead (its own stray staging waits out the grace); a pid that may
 * not be signalled (`EPERM`) is alive. A recycled pid reads as alive, so the
 * hour's grace still backs this up.
 */
function isOwnerDead(stagingName: string): boolean {
  const pid = Number(STAGING_OWNER.exec(stagingName)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * The tree graph's key: the tree root, the physical collection, the base
 * version and the delta's content digest. The tree root stays in the key so
 * two trees with byte-identical deltas keep separate graphs — retention is per
 * tree, and a dead tree's graphs go with it.
 */
function treeGraphKey(
  treeRoot: string,
  physical: PhysicalCollectionName,
  baseVersion: string,
  deltaDigest: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([treeRoot, physical, baseVersion, deltaDigest]))
    .digest("hex");
}

/** When a sweep of this root last started, by any process; undefined when never (or unreadable). */
async function readSweepStamp(stampPath: string): Promise<number | undefined> {
  try {
    const stamp = JSON.parse(await fs.readFile(stampPath, "utf8")) as { sweptAt?: unknown };
    return typeof stamp.sweptAt === "number" ? stamp.sweptAt : undefined;
  } catch {
    return undefined;
  }
}

/** The bytes of every regular file under `dir` (logical sizes); 0 when unreadable. */
async function bytesUnder(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await listDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      total += await bytesUnder(path);
      continue;
    }
    total += (await fs.stat(path).catch(() => undefined))?.size ?? 0;
  }
  return total;
}

async function removeIfEmpty(dir: string): Promise<void> {
  if ((await listDir(dir)).length === 0) await fs.rmdir(dir).catch(() => undefined);
}

function isDirectoryTaken(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOTEMPTY" || code === "EEXIST";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
