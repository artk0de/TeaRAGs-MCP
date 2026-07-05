/**
 * BlameWorkerPool — main-side host of N churn-walk workers used to compute the
 * FILE-phase git blame OFF the ingest main thread (bd tea-rags-mcp-dog1v).
 *
 * The inline es-git in-process blame is a SYNC napi call that blocks the event
 * loop; on a cold reindex of a large monolith that starves embedding (34k+
 * sync blames on main). Step 0 (scripts/spikes/esgit-thread-safety.js) proved
 * es-git/libgit2 is thread-safe with a per-thread Repository handle, so each
 * worker opens its own adapter and blames a disjoint shard in parallel.
 *
 * Reuses the churn-walk worker.js (a "blame" job type); this host differs from
 * ChunkChurnWalkThread only in fan-out (N workers + file sharding vs one).
 * Provider-owned, lazily spawned on the first blame, closed at finalizeSignals.
 */

import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import type { BlameLine, GitAdapterKind } from "../../../../../adapters/vcs/types.js";
import { ChunkChurnWalkThreadError } from "../../errors.js";
import type { BlameJobInput, ChurnWalkThreadRequest, ChurnWalkThreadResponse } from "./protocol.js";

/** Worker script path — always compiled JS in build/ (worker_threads require
 *  compiled JS; same idiom as churn-walk/thread.ts). */
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)).replace("/src/", "/build/"), "worker.js");

/** How long close() waits for a graceful worker exit before terminate(). */
const CLOSE_TIMEOUT_MS = 5000;

interface PendingBlame {
  resolve: (blameByPath: Map<string, BlameLine[]>) => void;
  reject: (error: Error) => void;
}

export class BlameWorkerPool {
  private readonly size: number;
  private readonly workers: (Worker | undefined)[];
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingBlame>();

  constructor(size: number) {
    this.size = Math.max(1, size);
    this.workers = new Array<Worker | undefined>(this.size).fill(undefined);
  }

  /** Shard the files across the pool and blame each shard on its own worker,
   *  merging the per-shard blame maps. Zero files → empty map, no spawn. */
  async blame(
    repoRoot: string,
    gitAdapter: GitAdapterKind,
    files: { relPath: string; historyDepthHint: number }[],
    timeoutMs: number,
  ): Promise<Map<string, BlameLine[]>> {
    if (files.length === 0 || this.closed) return new Map();
    const shards: { relPath: string; historyDepthHint: number }[][] = Array.from({ length: this.size }, () => []);
    files.forEach((file, i) => shards[i % this.size].push(file));

    const maps = await Promise.all(
      shards.map(async (shard, workerIdx) =>
        shard.length === 0
          ? new Map<string, BlameLine[]>()
          : this.dispatch(workerIdx, { repoRoot, gitAdapter, files: shard, timeoutMs }),
      ),
    );

    const merged = new Map<string, BlameLine[]>();
    for (const map of maps) for (const [relPath, lines] of map) merged.set(relPath, lines);
    return merged;
  }

  /**
   * Idempotent teardown — posts "close" to every live worker, waits (bounded)
   * for graceful exits, hard-terminates the stragglers, then rejects any blame
   * still pending (its files fall back to unknown ownership, same as an inline
   * blame failure).
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const live = this.workers.filter((w): w is Worker => w !== undefined);
    this.workers.fill(undefined);
    await Promise.all(
      live.map(async (worker) => {
        try {
          worker.postMessage({ type: "close" } satisfies ChurnWalkThreadRequest);
          let timer: NodeJS.Timeout | undefined;
          const timedOut = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => {
              resolve("timeout");
            }, CLOSE_TIMEOUT_MS);
          });
          const outcome = await Promise.race([once(worker, "exit").then(() => "exit" as const), timedOut]);
          if (timer) clearTimeout(timer);
          if (outcome === "timeout") await worker.terminate();
        } catch {
          await worker.terminate().catch(() => undefined);
        }
      }),
    );
    this.rejectAll(new ChunkChurnWalkThreadError("blame pool closed with blames still pending"));
  }

  private async dispatch(workerIdx: number, job: BlameJobInput): Promise<Map<string, BlameLine[]>> {
    const worker = this.ensureWorker(workerIdx);
    const id = this.nextId++;
    return new Promise<Map<string, BlameLine[]>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "blame", id, job } satisfies ChurnWalkThreadRequest);
    });
  }

  private ensureWorker(idx: number): Worker {
    const existing = this.workers[idx];
    if (existing) return existing;
    if (this.closed) throw new ChunkChurnWalkThreadError("blame() after close()");
    const worker = new Worker(WORKER_PATH);
    worker.on("message", (response: ChurnWalkThreadResponse) => {
      this.onResponse(response);
    });
    worker.on("error", (error: Error) => {
      this.rejectAll(new ChunkChurnWalkThreadError("blame worker error", error));
    });
    worker.on("exit", (code: number) => {
      if (!this.closed && code !== 0) {
        this.rejectAll(new ChunkChurnWalkThreadError(`blame worker exited unexpectedly (code ${code})`));
      }
    });
    this.workers[idx] = worker;
    return worker;
  }

  private onResponse(response: ChurnWalkThreadResponse): void {
    if (response.type !== "blamed" && response.type !== "blame-failed") return;
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (response.type === "blamed") entry.resolve(response.blameByPath);
    else entry.reject(new ChunkChurnWalkThreadError(response.error));
  }

  private rejectAll(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}
