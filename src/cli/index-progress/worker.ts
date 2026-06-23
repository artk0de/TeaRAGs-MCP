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
          const stat = statSync(full);
          // Use allocated blocks (512-byte units) to get real on-disk usage.
          // Sparse mmap segment files (e.g. Qdrant embedded collections) have
          // large logical size but few allocated blocks — stat.size is wildly
          // inflated (1.5 GB apparent vs 382 MB actual observed live).
          // Fallback for exotic platforms where blocks is undefined: round up
          // to nearest 512-byte sector so the result is never NaN.
          total += stat.blocks !== undefined ? stat.blocks * 512 : Math.ceil(stat.size / 512) * 512;
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
 * Returns true when QDRANT_URL points at a genuinely remote host (not localhost/127.0.0.1/[::1]).
 * Embedded daemon is addressed via a localhost URL — that still counts as local.
 * Unparseable URLs are treated as not-remote (proceed to compute size).
 */
function isRemoteQdrantUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1";
  } catch {
    return false;
  }
}

/**
 * Resolve the on-disk size of an embedded Qdrant collection directory.
 *
 * Returns undefined when:
 * - QDRANT_URL is set and points at a non-localhost remote (no local dir available)
 * - collectionName is undefined
 * - no versioned dir matching `<collectionName>_v<N>` exists under collections/
 *
 * The embedded Qdrant stores collections under a versioned name:
 * `<collections>/<collectionName>_v<N>` (e.g. `code_f78fcda5_v1`). The alias
 * itself (`code_f78fcda5`) is never a real directory — always pick the highest N.
 *
 * Why: live-validation found that (a) the embedded daemon is addressed via a
 * localhost URL so QDRANT_URL is always set in embedded mode, and (b) the real
 * on-disk dir has a `_v<N>` suffix that the alias name lacks.
 */
export function resolveIndexSizeBytes(collectionName: string | undefined): number | undefined {
  // Skip only for genuinely remote Qdrant (non-localhost host).
  if (process.env.QDRANT_URL && isRemoteQdrantUrl(process.env.QDRANT_URL)) return undefined;
  if (!collectionName) return undefined;

  const storagePath = process.env.QDRANT_EMBEDDED_STORAGE_PATH
    ? process.env.QDRANT_EMBEDDED_STORAGE_PATH
    : join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "qdrant");

  const collectionsDir = join(storagePath, "collections");

  // Resolve the highest versioned dir: `<collectionName>_v<N>`.
  let versionedDir: string | undefined;
  try {
    const versionPattern = new RegExp(`^${collectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}_v(\\d+)$`);
    let highestVersion = -1;
    for (const entry of readdirSync(collectionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = versionPattern.exec(entry.name);
      if (match) {
        const version = parseInt(match[1], 10);
        if (version > highestVersion) {
          highestVersion = version;
          versionedDir = join(collectionsDir, entry.name);
        }
      }
    }
  } catch {
    // collections/ dir does not exist or is unreadable
    return undefined;
  }

  if (!versionedDir) return undefined;

  const size = computeDirSize(versionedDir);
  return size > 0 ? size : undefined;
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
  const earlyCodegraphSizeBytes = resolveCodegraphSizeBytes(earlyStatus.collectionName);
  send({
    type: "status",
    status: {
      ...earlyStatus,
      enrichmentMetrics: indexStats.enrichmentMetrics,
      ...(earlyIndexSizeBytes !== undefined ? { indexSizeBytes: earlyIndexSizeBytes } : {}),
      ...(earlyCodegraphSizeBytes !== undefined ? { codegraphSizeBytes: earlyCodegraphSizeBytes } : {}),
    },
  });

  // Keep this (possibly detached) process alive until enrichment finishes.
  const enrichmentStart = now();
  await app.whenEnrichmentComplete();
  send({ type: "phase-done", phase: "enrichment", elapsedMs: now() - enrichmentStart });

  const finalStatus = await app.getIndexStatus(path);
  const finalIndexSizeBytes = resolveIndexSizeBytes(finalStatus.collectionName);
  const finalCodegraphSizeBytes = resolveCodegraphSizeBytes(finalStatus.collectionName);
  const enrichedFinalStatus: IndexStatus = {
    ...finalStatus,
    enrichmentMetrics: indexStats.enrichmentMetrics,
    ...(finalIndexSizeBytes !== undefined ? { indexSizeBytes: finalIndexSizeBytes } : {}),
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
