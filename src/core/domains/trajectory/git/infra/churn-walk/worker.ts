/**
 * Churn-walk worker thread entry (bd tea-rags-mcp-iqpuu) — compiled to
 * build/.../churn-walk/worker.js and spawned by ChunkChurnWalkPool (walk jobs)
 * and BlameWorkerPool (blame jobs).
 *
 * Owns the WHOLE walk pipeline off the ingest main thread: per-batch jobs
 * arrive fully serialized (protocol.ts) and the worker runs
 * buildChunkChurnMapUncached with its OWN run-scoped state —
 *
 *   - one CatFileBatchReader per repoRoot (lazy spawn, so an idle worker
 *     holds no `git cat-file` process; closed on the "close" envelope),
 *   - one CommitDiffMemo shared across every walk of the worker's lifetime
 *     (same run-scoped semantics ChunkPhase gave the inline path),
 *   - one shared Semaphore bounding concurrent commit holds across walks
 *     (mirrors the main-side CHUNK_ENRICHMENT_CONCURRENCY-bound semaphore).
 *
 * The discovery matrix is NOT rebuilt here: the main side pre-slices
 * commitEntries + bugFixShas and the worker wraps them in a static
 * WalkCommitDiscovery adapter — the walk code path stays identical to inline.
 */

import { parentPort } from "node:worker_threads";

import { VcsAdapterFactory } from "../../../../../adapters/vcs/factory.js";
import type { VcsGitAdapter } from "../../../../../adapters/vcs/git/adapter.js";
import type { BlameLine, BlobBatchReader, GitAdapterKind } from "../../../../../adapters/vcs/types.js";
import { CommitDiffMemo } from "../../../../../infra/commit-diff-memo.js";
import { Semaphore } from "../../../../../infra/semaphore.js";
import { buildChunkChurnMapUncached } from "../chunk-reader.js";
import type { ChunkChurnWalkStats, WalkCommitDiscovery } from "../walk-commits.js";
import type {
  BlameJobInput,
  BlameOutcome,
  ChunkChurnWalkJobInput,
  ChunkChurnWalkOutcome,
  ChurnWalkThreadRequest,
  ChurnWalkThreadResponse,
} from "./protocol.js";

/** Worker-owned run-scoped adapters, one per repoRoot — built IN-THREAD from
 *  the job's structured-clone-safe kind (worker-DI: instances never cross
 *  postMessage). */
const adapters = new Map<string, VcsGitAdapter>();
/** Worker-owned run-scoped readers, one per repoRoot (lazy git spawn inside). */
const readers = new Map<string, BlobBatchReader>();

/** Worker-owned adapter per repoRoot — created in-thread via the factory. */
async function adapterFor(kind: GitAdapterKind, repoRoot: string): Promise<VcsGitAdapter> {
  let adapter = adapters.get(repoRoot);
  if (!adapter) {
    adapter = await VcsAdapterFactory.create(kind, repoRoot);
    adapters.set(repoRoot, adapter);
  }
  return adapter;
}

/**
 * Resolve (create-or-reuse) the worker's blob reader for a job — ONE
 * long-lived reader per repoRoot, reused across every walk of the worker's
 * lifetime; the underlying git process spawns lazily on the first read.
 */
export async function resolveWalkBlobReader(kind: GitAdapterKind, repoRoot: string): Promise<BlobBatchReader> {
  let reader = readers.get(repoRoot);
  if (!reader) {
    reader = (await adapterFor(kind, repoRoot)).createBlobBatchReader();
    readers.set(repoRoot, reader);
  }
  return reader;
}
/** Worker-owned (commitSha, filePath) → hunks memo shared across walks. */
const memo = new CommitDiffMemo();
/** Worker-owned shared limiter — sized from the first job's concurrency. */
let sharedLimiter: Semaphore | undefined;

const ZERO_STATS: ChunkChurnWalkStats = {
  files: 0,
  commits: 0,
  holdCount: 0,
  semWaitMs: 0,
  blobReads: 0,
  patches: 0,
  memoHits: 0,
  wallMs: 0,
};

/* v8 ignore start -- worker-thread entry: runWalk/runBlame/handleClose + the parentPort message loop run only inside the churn-walk Worker isolate, which v8 coverage (main test thread) structurally cannot observe */
async function runWalk(job: ChunkChurnWalkJobInput): Promise<ChunkChurnWalkOutcome> {
  sharedLimiter ??= new Semaphore(job.concurrency);
  const adapter = await adapterFor(job.gitAdapter, job.repoRoot);
  const reader = await resolveWalkBlobReader(job.gitAdapter, job.repoRoot);

  // Static adapter over the pre-sliced job data — the walk consumes it
  // exactly like the run-scoped GitCommitDiscovery on the inline path.
  const discovery: WalkCommitDiscovery = {
    commitsForFiles: async () => job.commitEntries,
    getBugFixShas: async () => job.bugFixShas,
  };

  // An empty relativeChunkMap short-circuits before the walk and never fires
  // the callback — report zeroed stats for that case.
  let stats: ChunkChurnWalkStats = ZERO_STATS;
  const overlays = await buildChunkChurnMapUncached(
    adapter,
    job.relativeChunkMap,
    {},
    job.concurrency,
    job.maxAgeMonths,
    job.fileChurnData,
    job.squashOpts,
    job.chunkTimeoutMs,
    job.maxFileLines,
    job.useSharedLimiter ? sharedLimiter : undefined,
    job.blameByPath,
    reader,
    memo,
    discovery,
    (walkStats) => {
      stats = walkStats;
    },
  );
  return { overlays, stats };
}

/** Compute blame for a batch of shallow-history files on THIS worker thread
 *  (bd tea-rags-mcp-dog1v). Serial per worker: in-process es-git blame is a
 *  sync napi call — concurrency on one thread yields nothing (that is exactly
 *  why the inline path stalled). The pool's parallelism is N workers, each
 *  blaming a disjoint shard. */
async function runBlame(job: BlameJobInput): Promise<BlameOutcome> {
  const adapter = await adapterFor(job.gitAdapter, job.repoRoot);
  const blameByPath = new Map<string, BlameLine[]>();
  for (const { relPath, historyDepthHint } of job.files) {
    blameByPath.set(relPath, await adapter.blameFile(relPath, job.timeoutMs, historyDepthHint));
  }
  return { blameByPath };
}

async function handleClose(): Promise<void> {
  await Promise.all([...readers.values()].map(async (reader) => reader.close().catch(() => undefined)));
  readers.clear();
  adapters.clear();
  parentPort?.close();
}

if (parentPort) {
  parentPort.on("message", (request: ChurnWalkThreadRequest) => {
    void (async () => {
      if (request.type === "close") {
        await handleClose();
        return;
      }
      if (request.type === "blame") {
        try {
          const { blameByPath } = await runBlame(request.job);
          parentPort?.postMessage({ type: "blamed", id: request.id, blameByPath } satisfies ChurnWalkThreadResponse);
        } catch (error) {
          parentPort?.postMessage({
            type: "blame-failed",
            id: request.id,
            error: error instanceof Error ? error.message : String(error),
          } satisfies ChurnWalkThreadResponse);
        }
        return;
      }
      try {
        const { overlays, stats } = await runWalk(request.job);
        parentPort?.postMessage({ type: "walked", id: request.id, overlays, stats } satisfies ChurnWalkThreadResponse);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        parentPort?.postMessage({
          type: "walk-failed",
          id: request.id,
          error: message,
        } satisfies ChurnWalkThreadResponse);
      }
    })();
  });
}
/* v8 ignore stop */
