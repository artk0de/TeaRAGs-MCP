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
 *   file (`exportSnapshot`). The version hashes `(size, mtimeMs)` of the base
 *   `.duckdb` and its `.wal`, which reads never move, so every tree over one
 *   base state shares one snapshot. The graph file itself is named by the
 *   PHYSICAL collection (`<name>_vN`) — the alias would address a shadow file.
 * - `trees/<key>/` — one published tree graph, `key = sha256(tree root, delta
 *   fingerprint, physical, base version)`. Holds `codegraph/<physical>.duckdb`
 *   and `tree-graph.meta.json` (tree root, publish time, db path). Built into
 *   `<key>.staging-<pid>-<rand>` and renamed into place, so no reader — in this
 *   or a concurrent server — ever opens a half-built graph; a key dir that
 *   already exists when the build ends belongs to a process that won the race,
 *   and the staging copy is discarded.
 *
 * Scheduling: single-flight per key in-process; a caller waits at most its
 * `waitMs` and is told `building` past it while the build continues (the next
 * call joins the same promise); a finished failure is remembered per key for
 * `failureBackoffMs`, so a tree the build cannot handle does not fork a child
 * per request. Every outcome but `built` is a product answer — the reader
 * degrades to the base graph — so `graphFor` never rejects.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join, relative } from "node:path";

import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type {
  WorkingTreeGraphRequest,
  WorkingTreeGraphSource,
  WorkingTreeGraphState,
} from "../../../contracts/types/working-tree.js";
import { WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS } from "../../../domains/explore/working-tree/index.js";
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
const META_FILE = "tree-graph.meta.json";
const STAGING_MARKER = ".staging-";
/** `GraphDbClient#exportSnapshot` writes `<target>.snapshot-tmp` before its rename. */
const SNAPSHOT_TEMP_MARKER = ".snapshot-tmp";
const SNAPSHOT_FILE = /^(.+)-([0-9a-f]{16})\.duckdb$/;
/** Same rule as the chunk store: a collection name is one path segment, never an escape from the root. */
const COLLECTION_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The slice of `GraphDbClientPool` the cache reads the base graph through. */
export interface WorkingTreeGraphBasePool {
  hasDatabase: (physicalCollectionName: PhysicalCollectionName) => boolean;
  pathFor: (physicalCollectionName: PhysicalCollectionName) => string;
  exportSnapshot: (physicalCollectionName: PhysicalCollectionName, targetPath: string) => Promise<void>;
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
}

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
  key: string;
  graphDir: string;
}

/** One build attempt's end: published, or failed — and whether its snapshot vanished under it. */
type WorkingTreeGraphAttempt =
  | { kind: "published"; state: WorkingTreeGraphState }
  | { kind: "failed"; state: WorkingTreeGraphState; snapshotVanished: boolean };

const unavailable = (reason: string): WorkingTreeGraphState => ({ kind: "unavailable", reason });

export class WorkingTreeGraphCache implements WorkingTreeGraphSource {
  private readonly inflight = new Map<string, Promise<WorkingTreeGraphState>>();
  private readonly failures = new Map<string, { state: WorkingTreeGraphState; until: number }>();
  private readonly snapshotExports = new Map<string, Promise<void>>();
  /** Snapshots a running build of THIS process reads — never removed under it. */
  private readonly snapshotsInUse = new Map<string, number>();
  /** Staging dirs THIS process is building into — never swept under it. */
  private readonly stagingInUse = new Set<string>();
  private readonly now: () => number;
  private readonly failureBackoffMs: number;

  constructor(private readonly deps: WorkingTreeGraphCacheDeps) {
    this.now = deps.now ?? Date.now;
    this.failureBackoffMs = deps.failureBackoffMs ?? WORKING_TREE_GRAPH_FAILURE_BACKOFF_MS;
  }

  async graphFor(request: WorkingTreeGraphRequest, waitMs: number): Promise<WorkingTreeGraphState> {
    const work = this.resolve(request).catch((err: unknown) =>
      unavailable(`tree graph cache error: ${errorMessage(err)}`),
    );
    let timer: NodeJS.Timeout | undefined;
    const lapse = new Promise<WorkingTreeGraphState>((resolve) => {
      timer = setTimeout(
        () => {
          resolve(unavailable(WORKING_TREE_GRAPH_BUILDING_REASON));
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
   * once; per tree only the newest published graph stays; a snapshot whose
   * base version is no longer the live one goes; staging dirs and snapshot
   * temp files older than an hour are dead writes. Nothing outside
   * `<rootDir>/<collection>/graph/` is touched.
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

  private async resolve(request: WorkingTreeGraphRequest): Promise<WorkingTreeGraphState> {
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

    const key = treeGraphKey(request, physical, baseVersion);
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
        key,
        graphDir: join(this.deps.rootDir, collectionName, "graph"),
      };
      build = this.publishOnce(job).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, build);
    }
    return build;
  }

  private async resolvePhysical(collectionName: string): Promise<PhysicalCollectionName> {
    const fallback = (): PhysicalCollectionName => resolvePhysicalCollection(collectionName, []);
    if (!this.deps.resolveActiveCollection) return fallback();
    return this.deps.resolveActiveCollection(collectionName).catch(fallback);
  }

  /**
   * The published graph of the job's key, building it first when no process
   * has. A build whose snapshot is gone afterwards lost it to another server's
   * sweep (it judged the version superseded, or the grace ran out under a slow
   * clone): the base version is re-read, its snapshot re-exported, and the
   * build retried ONCE before the failure is remembered. Detection is the
   * snapshot path's absence, never the child's message text.
   */
  private async publishOnce(job: WorkingTreeGraphJob): Promise<WorkingTreeGraphState> {
    const first = await this.buildAndPublish(job);
    if (first.kind === "published") return first.state;
    if (!first.snapshotVanished) return this.remember(job.key, first.state);

    const baseVersion = await baseGraphVersion(job.runtime.pool.pathFor(job.physical));
    if (!baseVersion) return this.remember(job.key, unavailable(`base codegraph for ${job.physical} vanished`));
    const retry: WorkingTreeGraphJob = {
      ...job,
      baseVersion,
      key: treeGraphKey(job.request, job.physical, baseVersion),
    };
    const joined = retry.key === job.key ? undefined : this.inflight.get(retry.key);
    if (joined) return joined;
    const second = await this.buildAndPublish(retry);
    if (second.kind === "published") return second.state;
    if (retry.key !== job.key) this.remember(retry.key, second.state);
    return this.remember(job.key, second.state);
  }

  /** One build attempt: publish the graph, or say how it failed and whether its snapshot vanished under it. */
  private async buildAndPublish(job: WorkingTreeGraphJob): Promise<WorkingTreeGraphAttempt> {
    const treesDir = join(job.graphDir, "trees");
    const keyDir = join(treesDir, job.key);
    const published = await readPublished(keyDir, job.physical);
    if (published) return { kind: "published", state: published };

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
    this.stagingInUse.add(staging);
    try {
      snapshotPath = await this.ensureSnapshot(job);
      this.retainSnapshot(snapshotPath, 1);
      await fs.mkdir(staging, { recursive: true });
      const outcome = await this.deps.builder.build(
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
      return state
        ? { kind: "published", state }
        : failed(unavailable(`tree graph ${keyDir} was published without a readable graph`));
    } catch (err) {
      return failed(unavailable(`tree graph build failed: ${errorMessage(err)}`));
    } finally {
      if (snapshotPath) this.retainSnapshot(snapshotPath, -1);
      this.stagingInUse.delete(staging);
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private remember(key: string, state: WorkingTreeGraphState): WorkingTreeGraphState {
    this.failures.set(key, { state, until: this.now() + this.failureBackoffMs });
    return state;
  }

  /**
   * The snapshot of the job's base version, exported once (single-flight per
   * path). After a fresh export, older versions of the same physical graph are
   * removed once past the superseded grace — never one a running build of this
   * process still clones, nor one a build elsewhere may have just picked.
   */
  private async ensureSnapshot(job: WorkingTreeGraphJob): Promise<string> {
    const snapshotsDir = join(job.graphDir, "snapshots");
    const snapshotPath = join(snapshotsDir, `${job.physical}-${job.baseVersion}.duckdb`);
    if (existsSync(snapshotPath)) return snapshotPath;
    let exporting = this.snapshotExports.get(snapshotPath);
    if (!exporting) {
      exporting = (async () => {
        await fs.mkdir(snapshotsDir, { recursive: true });
        await job.runtime.pool.exportSnapshot(job.physical, snapshotPath);
        for (const entry of await listDir(snapshotsDir)) {
          const parsed = SNAPSHOT_FILE.exec(entry.name);
          if (parsed?.[1] !== job.physical || parsed[2] === job.baseVersion) continue;
          const path = join(snapshotsDir, entry.name);
          if (await isOlderThan(path, Date.now(), WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS)) {
            await this.removeSnapshot(path);
          }
        }
      })().finally(() => {
        this.snapshotExports.delete(snapshotPath);
      });
      this.snapshotExports.set(snapshotPath, exporting);
    }
    await exporting;
    return snapshotPath;
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
    const graphsPerTree = new Map<string, { dir: string; publishedAt: number }[]>();
    for (const entry of await listDir(treesDir)) {
      const dir = join(treesDir, entry.name);
      if (entry.name.includes(STAGING_MARKER)) {
        if (!this.stagingInUse.has(dir) && (await isOlderThanGrace(dir, at))) {
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
      graphs.push({ dir, publishedAt: meta.publishedAt });
      graphsPerTree.set(meta.treeRoot, graphs);
    }
    // Per tree the newest graph stays; the others go once the newest has been
    // published for the superseded grace — a reader in another server may
    // still hold an older one open until then.
    for (const graphs of graphsPerTree.values()) {
      graphs.sort((a, b) => b.publishedAt - a.publishedAt);
      const [newest, ...older] = graphs;
      const supersededLongEnough = at - newest.publishedAt >= WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS;
      result.keptGraphs++;
      for (const graph of older) {
        if (!supersededLongEnough) {
          result.keptGraphs++;
          continue;
        }
        await fs.rm(graph.dir, { recursive: true, force: true });
        result.evictedGraphs++;
      }
    }
  }

  private async sweepSnapshots(snapshotsDir: string, at: number, result: WorkingTreeGraphCacheSweep): Promise<void> {
    const runtime = this.deps.codegraph();
    const liveVersions = new Map<string, string | undefined>();
    const liveVersionOf = async (physical: PhysicalCollectionName): Promise<string | undefined> => {
      if (!liveVersions.has(physical)) {
        const live = runtime?.pool.hasDatabase(physical)
          ? await baseGraphVersion(runtime.pool.pathFor(physical))
          : undefined;
        liveVersions.set(physical, live);
      }
      return liveVersions.get(physical);
    };
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
      if (!parsed) continue;
      const [physical] = physicalCollectionNamesListedByStorage([parsed[1]]);
      if ((await liveVersionOf(physical)) === parsed[2]) continue;
      if (!(await isOlderThan(path, at, WORKING_TREE_GRAPH_SUPERSEDED_GRACE_MS))) continue;
      if (await this.removeSnapshot(path)) result.evictedSnapshots++;
    }
  }
}

/**
 * Sweep now and every `intervalMs` (the chunk store's cadence) on a timer that
 * does not hold the process open; returns the stop.
 */
export function scheduleWorkingTreeGraphSweep(
  cache: Pick<WorkingTreeGraphCache, "sweep">,
  intervalMs: number = WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS,
): () => void {
  const sweep = (): void => {
    void cache.sweep().catch(() => undefined);
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
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
 * its `.wal`. Every write moves one of them; a read moves neither. `undefined`
 * when the database file is gone.
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

function treeGraphKey(request: WorkingTreeGraphRequest, physical: PhysicalCollectionName, baseVersion: string): string {
  return createHash("sha256")
    .update(JSON.stringify([request.tree.root, request.fingerprint, physical, baseVersion]))
    .digest("hex");
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
