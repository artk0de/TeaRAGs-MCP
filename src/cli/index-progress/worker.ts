/**
 * Detached worker entry for `index-codebase`.
 *
 * Runs the real indexing through `App`, streams embedding + enrichment progress
 * to the foreground supervisor over IPC, then keeps the (detached) process alive
 * until background enrichment settles — so enrichment finishes even after the
 * supervisor detaches in default mode. Exits non-zero if any provider failed.
 *
 * `runIndexWorker` is the testable core (fake App + send spy); `main` is the
 * bootstrap entry the forked process executes.
 */

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { App, IndexOptions, IndexStatus } from "../../core/api/public/index.js";
import type { EnrichmentOutcome, WorkerMessage } from "./ipc-protocol.js";

/** Structural subset of App the worker needs — keeps test fakes minimal. */
export interface IndexWorkerApp {
  indexCodebase: App["indexCodebase"];
  getIndexStatus: App["getIndexStatus"];
  whenEnrichmentComplete: App["whenEnrichmentComplete"];
}

/**
 * Recursively compute the total byte size of a directory.
 * Returns 0 on any I/O error (non-existent path, permission denied).
 * Used to populate `indexSizeBytes` for embedded Qdrant collections only.
 */
export function computeDirSize(dirPath: string): number {
  try {
    let total = 0;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += computeDirSize(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          total += statSync(full).size;
        } catch {
          // skip unreadable file
        }
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Resolve the on-disk size of an embedded Qdrant collection directory.
 * Returns undefined when QDRANT_URL is set (remote Qdrant — no local dir to read)
 * or when the collection directory does not exist yet.
 */
export function resolveIndexSizeBytes(collectionName: string | undefined): number | undefined {
  // Remote Qdrant: no local dir available.
  if (process.env.QDRANT_URL) return undefined;
  if (!collectionName) return undefined;

  const storagePath = process.env.QDRANT_EMBEDDED_STORAGE_PATH
    ? process.env.QDRANT_EMBEDDED_STORAGE_PATH
    : join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "qdrant");

  const collectionDir = join(storagePath, "collections", collectionName);
  const size = computeDirSize(collectionDir);
  return size > 0 ? size : undefined;
}

/** Classify per-provider enrichment health into failed / degraded provider keys. */
export function deriveEnrichmentOutcome(status: IndexStatus): EnrichmentOutcome {
  const failed: string[] = [];
  const degraded: string[] = [];
  for (const [provider, health] of Object.entries(status.enrichment ?? {})) {
    const levels = [health.file.status, health.chunk.status];
    if (levels.includes("failed")) failed.push(provider);
    else if (levels.includes("degraded")) degraded.push(provider);
  }
  return { failed, degraded };
}

/**
 * Index, stream progress, await background enrichment, emit the final outcome.
 * `send` delivers a message to the supervisor (a no-op once the parent detaches).
 * `now` is an injectable clock (ms); defaults to Date.now for the real entry point.
 */
export async function runIndexWorker(
  app: IndexWorkerApp,
  path: string,
  options: IndexOptions,
  send: (message: WorkerMessage) => void,
  now: () => number = Date.now,
): Promise<EnrichmentOutcome> {
  const embeddingStart = now();
  const indexStats = await app.indexCodebase(
    path,
    options,
    (p) => {
      send({
        type: "embedding",
        phase: p.phase,
        percentage: p.percentage,
        current: p.current,
        total: p.total,
        throughput: p.throughput,
      });
    },
    (e) => {
      send({ type: "enrichment", providerKey: e.providerKey, level: e.level, applied: e.applied, total: e.total });
    },
  );
  send({ type: "phase-done", phase: "embedding", elapsedMs: now() - embeddingStart });

  // Index is searchable now (alias switched) — report status before blocking on
  // enrichment, so the supervisor's default mode can print it and detach.
  const earlyStatus = await app.getIndexStatus(path);
  const earlyIndexSizeBytes = resolveIndexSizeBytes(earlyStatus.collectionName);
  send({
    type: "status",
    status: {
      ...earlyStatus,
      enrichmentMetrics: indexStats.enrichmentMetrics,
      ...(earlyIndexSizeBytes !== undefined ? { indexSizeBytes: earlyIndexSizeBytes } : {}),
    },
  });

  // Keep this (possibly detached) process alive until enrichment finishes.
  const enrichmentStart = now();
  await app.whenEnrichmentComplete();
  send({ type: "phase-done", phase: "enrichment", elapsedMs: now() - enrichmentStart });

  const finalStatus = await app.getIndexStatus(path);
  const finalIndexSizeBytes = resolveIndexSizeBytes(finalStatus.collectionName);
  const enrichedFinalStatus: IndexStatus = {
    ...finalStatus,
    enrichmentMetrics: indexStats.enrichmentMetrics,
    ...(finalIndexSizeBytes !== undefined ? { indexSizeBytes: finalIndexSizeBytes } : {}),
  };
  send({ type: "status", status: enrichedFinalStatus });
  const outcome = deriveEnrichmentOutcome(enrichedFinalStatus);
  send({ type: "done", result: outcome });
  return outcome;
}

/** Worker params handed over by the supervisor through the environment. */
interface WorkerParams {
  path: string;
  options: IndexOptions;
}

/** Bootstrap entry executed by the forked worker process. */
export async function main(): Promise<void> {
  const raw = process.env.TEA_RAGS_INDEX_WORKER;
  if (!raw) {
    process.stderr.write("[tea-rags] worker invoked without TEA_RAGS_INDEX_WORKER params\n");
    process.exit(1);
  }
  const { path, options } = JSON.parse(raw) as WorkerParams;

  const send = (message: WorkerMessage): void => {
    try {
      process.send?.(message);
    } catch {
      // Parent detached (default mode) — IPC channel closed; keep working silently.
    }
  };

  const { parseAppConfig } = await import("../../bootstrap/config/index.js");
  const { createAppContext } = await import("../../bootstrap/factory.js");
  const { migrateHomeDir } = await import("../../bootstrap/migrate.js");

  migrateHomeDir();
  const ctx = await createAppContext(parseAppConfig());
  try {
    const outcome = await runIndexWorker(ctx.app, path, options, send);
    ctx.cleanup?.();
    process.exit(outcome.failed.length > 0 ? 1 : 0);
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : String(error) });
    try {
      ctx.cleanup?.();
    } catch {
      // best-effort cleanup
    }
    process.exit(1);
  }
}
