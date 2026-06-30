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
 * Returns the real on-disk size of a single file in bytes (blocks * 512).
 * Falls back to the next-512-byte-boundary of stat.size when blocks is undefined.
 * Returns 0 on any error (non-existent path, permission denied).
 */
function computeFileSize(filePath: string): number {
  try {
    const st = statSync(filePath);
    return st.blocks !== undefined ? st.blocks * 512 : Math.ceil(st.size / 512) * 512;
  } catch {
    return 0;
  }
}

/**
 * Resolve the on-disk size of the codegraph DuckDB file for a collection.
 *
 * Returns undefined when:
 * - CODEGRAPH_ENABLED is not set or is "false"
 * - collectionName is undefined
 * - no versioned file matching `<collectionName>_v<N>.duckdb` exists in the codegraph dir
 *
 * The codegraph stores databases under `<dataDir>/codegraph/<collectionName>_v<N>.duckdb`.
 * Size = real disk usage of the .duckdb file + its .duckdb.wal sibling (if present).
 * Picks the highest version N when multiple versions exist.
 */
export function resolveCodegraphSizeBytes(collectionName: string | undefined): number | undefined {
  const enabled = process.env.CODEGRAPH_ENABLED;
  if (!enabled || enabled === "false") return undefined;
  if (!collectionName) return undefined;

  const codegraphDir = join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "codegraph");

  let highestVersion = -1;
  let versionedBaseName: string | undefined;
  try {
    const versionPattern = new RegExp(`^${collectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)\\.duckdb$`);
    for (const entry of readdirSync(codegraphDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const match = versionPattern.exec(entry.name);
      if (match) {
        const version = parseInt(match[1], 10);
        if (version > highestVersion) {
          highestVersion = version;
          versionedBaseName = entry.name;
        }
      }
    }
  } catch {
    // codegraph dir does not exist or is unreadable
    return undefined;
  }

  if (!versionedBaseName) return undefined;

  const dbPath = join(codegraphDir, versionedBaseName);
  const walPath = `${dbPath}.wal`;
  const size = computeFileSize(dbPath) + computeFileSize(walPath);
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
        totalFinal: p.totalFinal,
      });
    },
    (e) => {
      send({
        type: "enrichment",
        providerKey: e.providerKey,
        level: e.level,
        applied: e.applied,
        total: e.total,
        totalFinal: e.totalFinal,
      });
    },
  );
  send({ type: "phase-done", phase: "embedding", elapsedMs: now() - embeddingStart });

  // Index is searchable now (alias switched) — report status before blocking on
  // enrichment, so the supervisor's default mode can print it and detach.
  const earlyStatus = await app.getIndexStatus(path);
  const earlyCodegraphSizeBytes = resolveCodegraphSizeBytes(earlyStatus.collectionName);
  send({
    type: "status",
    status: {
      ...earlyStatus,
      enrichmentMetrics: indexStats.enrichmentMetrics,
      ...(earlyCodegraphSizeBytes !== undefined ? { codegraphSizeBytes: earlyCodegraphSizeBytes } : {}),
    },
  });

  // Keep this (possibly detached) process alive until enrichment finishes.
  const enrichmentStart = now();
  await app.whenEnrichmentComplete();
  send({ type: "phase-done", phase: "enrichment", elapsedMs: now() - enrichmentStart });

  const finalStatus = await app.getIndexStatus(path);
  const finalCodegraphSizeBytes = resolveCodegraphSizeBytes(finalStatus.collectionName);
  const enrichedFinalStatus: IndexStatus = {
    ...finalStatus,
    enrichmentMetrics: indexStats.enrichmentMetrics,
    ...(finalCodegraphSizeBytes !== undefined ? { codegraphSizeBytes: finalCodegraphSizeBytes } : {}),
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
  // Surface a one-time "Migrating to TurboQuant" phase: the startup reconcile in
  // createAppContext migrates any pre-turbo collection and polls the optimizer
  // pass, forwarding each progress event to the supervisor over the same IPC
  // channel as embedding/enrichment progress.
  const ctx = await createAppContext(parseAppConfig(), {
    onTurboMigration: (event) => {
      send({
        type: "turbo-migration",
        collection: event.collection,
        stage: event.stage,
        ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
      });
    },
  });
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
