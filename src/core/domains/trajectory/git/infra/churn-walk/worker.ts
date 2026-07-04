/**
 * Churn-walk worker thread entry (bd tea-rags-mcp-iqpuu) — compiled to
 * build/.../churn-walk/worker.js and spawned by ChunkChurnWalkThread.
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

import { createCatFileBatch, type CatFileBatchReader } from "../../../../../adapters/git/client.js";
import { CommitDiffMemo } from "../../../../../infra/commit-diff-memo.js";
import { Semaphore } from "../../../../../infra/semaphore.js";
import { buildChunkChurnMapUncached } from "../chunk-reader.js";
import type { ChunkChurnWalkStats, WalkCommitDiscovery } from "../walk-commits.js";
import type {
  ChunkChurnWalkJobInput,
  ChunkChurnWalkOutcome,
  ChurnWalkThreadRequest,
  ChurnWalkThreadResponse,
} from "./protocol.js";

/** Worker-owned run-scoped readers, one per repoRoot (lazy git spawn inside). */
const readers = new Map<string, CatFileBatchReader>();
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

async function runWalk(job: ChunkChurnWalkJobInput): Promise<ChunkChurnWalkOutcome> {
  sharedLimiter ??= new Semaphore(job.concurrency);
  let reader = readers.get(job.repoRoot);
  if (!reader) {
    reader = createCatFileBatch(job.repoRoot);
    readers.set(job.repoRoot, reader);
  }

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
    job.repoRoot,
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

async function handleClose(): Promise<void> {
  await Promise.all([...readers.values()].map(async (reader) => reader.close().catch(() => undefined)));
  readers.clear();
  parentPort?.close();
}

if (parentPort) {
  parentPort.on("message", (request: ChurnWalkThreadRequest) => {
    void (async () => {
      if (request.type === "close") {
        await handleClose();
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
