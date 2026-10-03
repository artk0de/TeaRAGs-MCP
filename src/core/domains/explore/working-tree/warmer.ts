/**
 * WorkingTreeDeltaWarmer (WTO unbounded delta, Task 5) — turns a tree's re-read
 * files into rows through the {@link WorkingTreeChunkLayer}, batch by batch, so
 * a view waits at most its budget and is answered with the files that are
 * ready. One instance per process; the composition root owns it.
 *
 * Queue: one, shared by every tree, with two lanes — `live` (a request is
 * waiting) is always taken before `background` (a watcher, or the rest of a
 * request whose budget lapsed). A batch holds up to `batchSize` paths of ONE
 * (tree, collection, chunker config) scope, handed to the layer in one call;
 * the layer chunks them concurrently and `put`s each file to its store, so a
 * process killed mid-warm keeps every finished file. One batch is in flight at
 * a time: a live request waits behind at most the batch already running.
 *
 * A path already queued is joined, never enqueued twice, and a live request
 * promotes it out of the background lane. A path in flight is joined only by a
 * request that arrived before the batch started (the batch reads the file
 * after the request began); a later request queues one follow-up, so an edit
 * made while a batch ran is never answered with that batch's read.
 *
 * Staleness: a result is remembered with the file's stat (inode, size, mtime,
 * ctime, nanosecond precision) taken BEFORE the layer read it. A later request
 * reuses it only when the file's stat is unchanged AND the remembered stat is
 * not racily fresh — its mtime and ctime lie more than `racyWindowMs` before
 * the moment it was taken, so a write after that moment must move one of them
 * (git's "racy clean" rule; the window covers coarse-timestamp filesystems).
 * Anything else is re-asked of the layer, which content-addresses by sha256 —
 * a memory hit there costs a read and a hash, never a chunk. A stat costs far
 * less than that read, which is what keeps a repeat request over a large warm
 * delta cheap; correctness rests on the layer whenever the stat cannot vouch.
 *
 * `warm` never rejects: a layer failure leaves its paths pending and the next
 * `warm` retries them.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { ChunkerConfig } from "../../../types.js";
import type { ScrollChunk } from "../chunk-grouping/types.js";
import type { WorkingTreeChunkLayer } from "./chunk-layer.js";
import type { WorkingTreeChunkStoreKey } from "./chunk-store.js";
import { WORKING_TREE_ROW_CACHE_MAX_BYTES, workingTreeRowBytes, WorkingTreeRowCache } from "./row-cache.js";

/** Paths handed to the chunk layer in one call. */
export const WORKING_TREE_WARM_BATCH_SIZE = 32;
/**
 * How far before its own stat a remembered file's timestamps must lie for the
 * stat to vouch for its content: 2 s covers the coarsest common timestamp
 * granularity (FAT).
 */
export const WORKING_TREE_WARM_RACY_WINDOW_MS = 2_000;

export type WorkingTreeDeltaWarmLane = "live" | "background";

export interface WorkingTreeDeltaWarmRequest {
  treeRoot: string;
  /** The base index — the chunk store's namespace. */
  collectionName: string;
  config: ChunkerConfig;
  /** The view's re-read files, relative to `treeRoot`. */
  paths: readonly string[];
}

export interface WorkingTreeDeltaWarmState {
  /** Rows of every warm file, in path order. */
  rows: readonly ScrollChunk[];
  /** Requested paths that are warm: chunked OR unparsed. */
  warmPaths: ReadonlySet<string>;
  /** Warm paths that could not be read or parsed — they have no rows. */
  unparsed: readonly string[];
  /** Requested paths not yet warm, in path order. */
  pending: readonly string[];
  /** The chunk-store entry of each chunked warm path. */
  storeKeys: ReadonlyMap<string, WorkingTreeChunkStoreKey>;
}

export interface WorkingTreeDeltaWarmerDeps {
  layer: Pick<WorkingTreeChunkLayer, "chunk">;
  /** Default {@link WORKING_TREE_WARM_BATCH_SIZE}. */
  batchSize?: number;
  /** Bound of the remembered results, in bytes of row content. Default {@link WORKING_TREE_ROW_CACHE_MAX_BYTES}. */
  maxRememberedBytes?: number;
  /** Default {@link WORKING_TREE_WARM_RACY_WINDOW_MS}. */
  racyWindowMs?: number;
  /** Wall clock, compared with file timestamps. */
  now?: () => number;
}

/** A file's stat identity: any write changes at least one field, given a non-racy stat. */
interface WorkingTreeFileStamp {
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  /** Wall-clock ms at which the stat was taken. */
  takenAtMs: number;
}

/** One warm path. */
interface WorkingTreeWarmResult {
  rows: readonly ScrollChunk[];
  unparsed: boolean;
  storeKey?: WorkingTreeChunkStoreKey;
  /** Taken before the layer read the file; absent when the file could not be stat'ed. */
  stamp?: WorkingTreeFileStamp;
}

interface WorkingTreeWarmScope {
  key: string;
  treeRoot: string;
  collectionName: string;
  config: ChunkerConfig;
}

/** One path waiting for, or being, chunked. */
interface WorkingTreeWarmJob {
  key: string;
  scope: WorkingTreeWarmScope;
  path: string;
  lane: WorkingTreeDeltaWarmLane;
  /**
   * Sequence number at which the job's batch handed its paths to the layer —
   * the layer reads the files after it. Absent while queued and while the
   * batch is still taking its stats.
   */
  startedAt?: number;
  waiters: Set<WorkingTreeWarmWaiter>;
}

/** One `warm` call waiting on its paths. */
interface WorkingTreeWarmWaiter {
  /** Paths it still waits on. */
  remaining: Set<string>;
  /** Paths it waits on that a queued or running job will answer. */
  attached: number;
  /** The jobs it is attached to — left when it answers. */
  jobs: Set<WorkingTreeWarmJob>;
  /** Results it has received, by path — held here so eviction cannot take them. */
  done: Map<string, WorkingTreeWarmResult>;
  finish: () => void;
}

export class WorkingTreeDeltaWarmer {
  private readonly batchSize: number;
  private readonly racyWindowMs: number;
  private readonly now: () => number;
  private readonly remembered: WorkingTreeRowCache<WorkingTreeWarmResult>;
  private readonly lanes: Record<WorkingTreeDeltaWarmLane, Map<string, WorkingTreeWarmJob>> = {
    live: new Map(),
    background: new Map(),
  };
  private readonly running = new Map<string, WorkingTreeWarmJob>();
  private readonly waiters = new Set<WorkingTreeWarmWaiter>();
  /** Orders requests against batch starts. */
  private sequence = 0;
  private draining: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: WorkingTreeDeltaWarmerDeps) {
    this.batchSize = Math.max(1, deps.batchSize ?? WORKING_TREE_WARM_BATCH_SIZE);
    this.racyWindowMs = deps.racyWindowMs ?? WORKING_TREE_WARM_RACY_WINDOW_MS;
    this.now = deps.now ?? Date.now;
    this.remembered = new WorkingTreeRowCache(deps.maxRememberedBytes ?? WORKING_TREE_ROW_CACHE_MAX_BYTES);
  }

  /**
   * Enqueues the request's paths that are not warm and resolves when every one
   * is warm, when nothing left can make progress (a layer failure), or when
   * `budgetMs` lapses — whichever comes first. Work left over continues in the
   * background. Never rejects.
   */
  async warm(
    request: WorkingTreeDeltaWarmRequest,
    budgetMs: number,
    lane: WorkingTreeDeltaWarmLane,
  ): Promise<WorkingTreeDeltaWarmState> {
    const requestedAt = ++this.sequence;
    const paths = [...new Set(request.paths)];
    const scope = scopeOf(request);
    const waiter: WorkingTreeWarmWaiter = {
      remaining: new Set(),
      attached: 0,
      jobs: new Set(),
      done: new Map(),
      finish: () => undefined,
    };
    const answered = new Promise<void>((resolve) => {
      const timer = setTimeout(
        () => {
          waiter.finish();
        },
        Math.max(0, budgetMs),
      );
      timer.unref?.();
      waiter.finish = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        for (const job of waiter.jobs) job.waiters.delete(waiter);
        waiter.jobs.clear();
        resolve();
      };
    });
    this.waiters.add(waiter);

    if (this.disposed) waiter.finish();
    else {
      // A path with no remembered result is enqueued at once; a remembered one
      // only once its stat fails to vouch for it. Until those stats are in, every
      // path counts as remaining and the stat itself holds one attachment, so no
      // early answer can skip them.
      const remembered: [string, WorkingTreeWarmResult][] = [];
      for (const path of paths) {
        waiter.remaining.add(path);
        const result = this.remembered.get(jobKey(scope, path));
        if (result) remembered.push([path, result]);
        else this.attach(scope, path, lane, requestedAt, waiter);
      }
      this.pump();
      if (remembered.length > 0) {
        waiter.attached++;
        const stamps = await Promise.all(
          remembered.map(async ([path]) => stampOf(join(scope.treeRoot, path), this.now)),
        );
        waiter.attached--;
        remembered.forEach(([path, result], index) => {
          if (this.vouches(result.stamp, stamps[index])) {
            waiter.done.set(path, result);
            waiter.remaining.delete(path);
          } else if (!this.disposed) this.attach(scope, path, lane, requestedAt, waiter);
        });
        this.pump();
      }
      if (this.disposed || waiter.remaining.size === 0 || waiter.attached === 0) waiter.finish();
    }

    await answered;
    return stateOf(paths, waiter.done);
  }

  /** Stops the queue: queued work is dropped, a running batch's answer is discarded, waiting requests answer now. */
  dispose(): void {
    this.disposed = true;
    this.lanes.live.clear();
    this.lanes.background.clear();
    this.running.clear();
    for (const waiter of [...this.waiters]) waiter.finish();
    this.remembered.clear();
  }

  /** Whether a remembered stamp still identifies the file's content. */
  private vouches(remembered: WorkingTreeFileStamp | undefined, current: WorkingTreeFileStamp | undefined): boolean {
    if (!remembered || !current) return false;
    const same =
      remembered.ino === current.ino &&
      remembered.size === current.size &&
      remembered.mtimeNs === current.mtimeNs &&
      remembered.ctimeNs === current.ctimeNs;
    if (!same) return false;
    const settledBeforeNs = BigInt(Math.floor(remembered.takenAtMs - this.racyWindowMs)) * 1_000_000n;
    return remembered.mtimeNs < settledBeforeNs && remembered.ctimeNs < settledBeforeNs;
  }

  private attach(
    scope: WorkingTreeWarmScope,
    path: string,
    lane: WorkingTreeDeltaWarmLane,
    requestedAt: number,
    waiter: WorkingTreeWarmWaiter,
  ): void {
    const key = jobKey(scope, path);
    let job = this.lanes.live.get(key) ?? this.lanes.background.get(key);
    if (job && lane === "live" && job.lane === "background") {
      this.lanes.background.delete(key);
      job.lane = "live";
      this.lanes.live.set(key, job);
    }
    if (!job) {
      const runningJob = this.running.get(key);
      // A batch that has not yet handed its paths to the layer, or handed them
      // after this request began, reads the file after the request began.
      if (runningJob && (runningJob.startedAt === undefined || runningJob.startedAt > requestedAt)) job = runningJob;
    }
    if (!job) {
      job = { key, scope, path, lane, waiters: new Set() };
      this.lanes[lane].set(key, job);
    }
    job.waiters.add(waiter);
    waiter.jobs.add(job);
    waiter.attached++;
  }

  private pump(): void {
    if (this.draining || this.disposed) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.lanes.live.size + this.lanes.background.size > 0) this.pump();
    });
  }

  private async drain(): Promise<void> {
    for (let batch = this.take(); batch; batch = this.take()) await this.run(batch);
  }

  /** The next batch: the oldest job of the highest non-empty lane, with the queued jobs of its lane and scope. */
  private take(): WorkingTreeWarmJob[] | undefined {
    if (this.disposed) return undefined;
    const lane = this.lanes.live.size > 0 ? this.lanes.live : this.lanes.background;
    const batch: WorkingTreeWarmJob[] = [];
    for (const job of lane.values()) {
      if (batch.length > 0 && job.scope.key !== batch[0].scope.key) continue;
      batch.push(job);
      if (batch.length === this.batchSize) break;
    }
    if (batch.length === 0) return undefined;
    for (const job of batch) {
      lane.delete(job.key);
      this.running.set(job.key, job);
    }
    return batch;
  }

  private async run(batch: WorkingTreeWarmJob[]): Promise<void> {
    const { scope } = batch[0];
    const paths = batch.map((job) => job.path);
    try {
      const stamps = await Promise.all(paths.map(async (path) => stampOf(join(scope.treeRoot, path), this.now)));
      // Same synchronous step as the layer call: no request can start between them.
      const startedAt = ++this.sequence;
      for (const job of batch) job.startedAt = startedAt;
      const read = await this.deps.layer.chunk(scope.treeRoot, paths, scope.config, scope.collectionName);
      if (this.disposed) return;
      const unparsed = new Set(read.unparsed);
      batch.forEach((job, index) => {
        const rows = read.rowsByPath?.get(job.path);
        if (unparsed.has(job.path)) {
          this.complete(job, { rows: [], unparsed: true, stamp: stamps[index] });
        } else if (rows) {
          const storeKey = read.storeKeys?.get(job.path);
          this.complete(job, { rows, unparsed: false, stamp: stamps[index], ...(storeKey ? { storeKey } : {}) });
        } else {
          this.fail(job);
        }
      });
    } catch {
      for (const job of batch) this.fail(job);
    } finally {
      for (const job of batch) if (this.running.get(job.key) === job) this.running.delete(job.key);
    }
  }

  private complete(job: WorkingTreeWarmJob, result: WorkingTreeWarmResult): void {
    this.remembered.set(job.key, result, workingTreeRowBytes(result.rows));
    for (const waiter of job.waiters) {
      waiter.done.set(job.path, result);
      waiter.remaining.delete(job.path);
      waiter.attached--;
      if (waiter.remaining.size === 0) waiter.finish();
    }
  }

  /** The path stays pending for its waiters; one with nothing left in progress answers now. */
  private fail(job: WorkingTreeWarmJob): void {
    for (const waiter of job.waiters) {
      waiter.attached--;
      if (waiter.attached === 0) waiter.finish();
    }
  }
}

function scopeOf(request: WorkingTreeDeltaWarmRequest): WorkingTreeWarmScope {
  const { treeRoot, collectionName, config } = request;
  return { key: `${treeRoot}\0${collectionName}\0${JSON.stringify(config)}`, treeRoot, collectionName, config };
}

function jobKey(scope: WorkingTreeWarmScope, path: string): string {
  return `${scope.key}\0${path}`;
}

async function stampOf(absolutePath: string, now: () => number): Promise<WorkingTreeFileStamp | undefined> {
  const takenAtMs = now();
  try {
    const stats = await stat(absolutePath, { bigint: true });
    return { ino: stats.ino, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, takenAtMs };
  } catch {
    return undefined;
  }
}

function stateOf(
  paths: readonly string[],
  done: ReadonlyMap<string, WorkingTreeWarmResult>,
): WorkingTreeDeltaWarmState {
  const rows: ScrollChunk[] = [];
  const warmPaths = new Set<string>();
  const unparsed: string[] = [];
  const pending: string[] = [];
  const storeKeys = new Map<string, WorkingTreeChunkStoreKey>();
  for (const path of paths) {
    const result = done.get(path);
    if (!result) {
      pending.push(path);
      continue;
    }
    warmPaths.add(path);
    if (result.unparsed) unparsed.push(path);
    rows.push(...result.rows);
    if (result.storeKey) storeKeys.set(path, result.storeKey);
  }
  return { rows, warmPaths, unparsed, pending, storeKeys };
}
