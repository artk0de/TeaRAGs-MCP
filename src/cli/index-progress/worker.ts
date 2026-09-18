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

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isEnrichmentRecompute, type App, type IndexOptions, type IndexStatus } from "../../core/api/public/index.js";
import type { EnrichmentOutcome, WorkerMessage } from "./ipc-protocol.js";
import { installParentDeathGuard } from "./parent-death-guard.js";
import { IndexWorkerRegistry, indexWorkerRegistryDir, type IndexWorkerRecord } from "./worker-registry.js";

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
  const indexElapsedMs = now() - embeddingStart;

  // `forceEnrichments` routes the run through `IndexingOps#recomputeEnrichments`,
  // which is TWO legs inside one call: an incremental sync (the indexing leg —
  // it chunks, stores and embeds whatever the working tree changed) followed by
  // the payload recompute, which embeds nothing. Booking the whole span as
  // `embedding` charged the recompute to the indexing leg: a codegraph recompute
  // reported `phases.embedding = 1,211,574 ms` against zero embed calls
  // (bd tea-rags-mcp-ghcof). The recompute measures itself and hands the number
  // back as `enrichmentDurationMs`, so subtracting it leaves exactly the sync —
  // ≈0 on the clean tree the flag is usually run against, and the real figure
  // when the tree was dirty. That remainder is what the embedding phase means
  // here: the bar it drives carries every pipeline phase, not embedding alone.
  const recomputeDurationMs = isEnrichmentRecompute(options)
    ? (indexStats.enrichmentDurationMs ?? indexElapsedMs)
    : undefined;
  send({
    type: "phase-done",
    phase: "embedding",
    elapsedMs: recomputeDurationMs === undefined ? indexElapsedMs : Math.max(0, indexElapsedMs - recomputeDurationMs),
  });

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
  // On the recompute path enrichment already finished INSIDE indexCodebase, so
  // the wait above is a no-op and its near-zero elapsed would understate the run
  // as badly as `embedding` overstated it. Report the recompute's own duration.
  send({
    type: "phase-done",
    phase: "enrichment",
    elapsedMs: recomputeDurationMs ?? now() - enrichmentStart,
  });

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

/** Structural subset of the worker's IPC end (`process`) — test-fakeable. */
export interface SupervisorChannel {
  readonly connected?: boolean;
  send?: (message: WorkerMessage) => boolean;
  on: (event: "error", listener: (error: NodeJS.ErrnoException) => void) => unknown;
}

/** Error codes a send raises once the supervisor's end of the channel is gone. */
const CLOSED_CHANNEL_CODES: ReadonlySet<string> = new Set(["ERR_IPC_CHANNEL_CLOSED", "EPIPE", "ECONNRESET"]);

/**
 * Send to the supervisor, tolerating its detach.
 *
 * In default mode the supervisor disconnects as soon as the index is
 * searchable, while the worker keeps enriching and keeps reporting progress.
 * A `send()` on the closed channel does NOT throw: Node emits `'error'` on the
 * next tick, and an unlistened `'error'` throws — the crash guard then exits 1,
 * killing enrichment mid-run and leaving every marker `in_progress`. So skip
 * sends once `connected` is false, and swallow the closed-channel errors of a
 * send that raced the disconnect.
 */
export function createSupervisorSend(channel: SupervisorChannel): (message: WorkerMessage) => void {
  channel.on("error", (error) => {
    if (error.code !== undefined && CLOSED_CHANNEL_CODES.has(error.code)) return;
    console.error("[tea-rags] worker IPC error:", error.stack ?? error.message);
  });
  return (message) => {
    if (channel.connected === false) return;
    channel.send?.(message);
  };
}

/** Structural subset of `process` the crash guard needs — test-fakeable. */
export interface WorkerCrashGuardProcess {
  on: (event: "uncaughtException" | "unhandledRejection", listener: (reason: unknown) => void) => unknown;
  exit: (code: number) => void;
}

/**
 * Last-resort crash guard for the detached worker (tea-rags-mcp-0ej8v).
 *
 * Without it an uncaught throw / unhandled rejection exits code 1 with ZERO
 * diagnostics: the fork discards worker stderr unless DEBUG opened the
 * worker-debug log, no IPC error is sent, and the supervisor can only print
 * "worker exited with code 1 before reporting a result" — a live
 * codegraph-finalize crash lost its cause entirely this way. The guard sends
 * the error over IPC (the supervisor renders it in both text and JSON modes)
 * and echoes the stack to stderr so a DEBUG re-run captures it on disk.
 */
export function installWorkerCrashGuard(proc: WorkerCrashGuardProcess, send: (message: WorkerMessage) => void): void {
  const report = (origin: "uncaughtException" | "unhandledRejection") => {
    return (reason: unknown): void => {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      console.error(`[tea-rags] worker ${origin}:`, err.stack ?? err.message);
      send({ type: "error", message: `${origin}: ${err.message}`, code: "WORKER_UNCAUGHT" });
      proc.exit(1);
    };
  };
  proc.on("uncaughtException", report("uncaughtException"));
  proc.on("unhandledRejection", report("unhandledRejection"));
}

/** Who a worker is, as its registry record states it. */
export type IndexWorkerIdentity = Omit<IndexWorkerRecord, "handedOffAtMs" | "lastProgressAtMs">;

/** What the worker tells its registry record over its life. */
export interface IndexWorkerTracker {
  /** The supervisor granted "outlive". */
  handedOff: () => void;
  /** The worker sent a progress message (recorded at most once per window). */
  progressed: () => void;
  /** The worker is exiting. */
  release: () => void;
}

/** A busy run sends many messages a second; its record needs a fresh stamp far less often. */
export const WORKER_PROGRESS_RECORD_INTERVAL_MS = 15_000;

/**
 * Register this worker for the orphan sweep (bd tea-rags-mcp-f924y) and keep its
 * record current. Best-effort throughout: a registry that cannot be written
 * costs the sweep its evidence, never the run its index — each failure is
 * reported once on stderr and otherwise ignored.
 */
export function trackIndexWorker(
  registry: IndexWorkerRegistry,
  identity: IndexWorkerIdentity,
  now: () => number = Date.now,
): IndexWorkerTracker {
  let reported = false;
  const bestEffort = (step: () => void): void => {
    try {
      step();
    } catch (error) {
      if (reported) return;
      reported = true;
      process.stderr.write(
        `[tea-rags] worker registry at ${registry.dir} is not writable (${(error as Error).message}) — ` +
          "`tea-rags doctor --sweep-workers` will not see this worker\n",
      );
    }
  };
  let lastRecordedAtMs = now();
  bestEffort(() => {
    registry.register({ ...identity, lastProgressAtMs: lastRecordedAtMs });
  });
  return {
    handedOff: () => {
      bestEffort(() => {
        registry.markHandedOff(identity.pid, now());
      });
    },
    progressed: () => {
      const at = now();
      if (at - lastRecordedAtMs < WORKER_PROGRESS_RECORD_INTERVAL_MS) return;
      lastRecordedAtMs = at;
      bestEffort(() => {
        registry.recordProgress(identity.pid, at);
      });
    },
    release: () => {
      bestEffort(() => {
        registry.unregister(identity.pid);
      });
    },
  };
}

/** The CLI entry this worker runs, symlinks resolved — which checkout's build it is. */
function resolveEntryScript(): string {
  const entry = process.argv[1] ?? "";
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
}

/** Bootstrap entry executed by the forked worker process. */
export async function main(): Promise<void> {
  const raw = process.env.TEA_RAGS_INDEX_WORKER;
  if (!raw) {
    process.stderr.write("[tea-rags] worker invoked without TEA_RAGS_INDEX_WORKER params\n");
    process.exit(1);
  }
  const { path, options } = JSON.parse(raw) as WorkerParams;

  // The record the orphan sweep proves this process by (bd tea-rags-mcp-f924y).
  const tracker = trackIndexWorker(new IndexWorkerRegistry(indexWorkerRegistryDir()), {
    pid: process.pid,
    supervisorPid: process.ppid,
    startedAtMs: Math.round(Date.now() - process.uptime() * 1000),
    entryScript: resolveEntryScript(),
    projectPath: path,
  });
  process.on("exit", tracker.release);

  // Parent-death guard: the worker runs in its OWN process group, so a killed
  // supervisor never reaches it or its git / chunker children. Without an
  // outlive grant, the supervisor's disconnect takes the whole group down.
  installParentDeathGuard(process, {
    onOutlive: tracker.handedOff,
    onOrphaned: () => {
      tracker.release();
      try {
        process.kill(-process.pid, "SIGKILL");
      } catch {
        // Not a process-group leader (inline/test invocation) — nothing to group-kill.
      }
      process.exit(1);
    },
  });

  const toSupervisor = createSupervisorSend(process);
  const send = (message: WorkerMessage): void => {
    toSupervisor(message);
    tracker.progressed();
  };

  // A crash anywhere past this point must surface over IPC + stderr instead of
  // a bare silent exit 1 (tea-rags-mcp-0ej8v).
  installWorkerCrashGuard(process, send);

  const { parseAppConfig } = await import("../../bootstrap/config/index.js");
  const { createAppContext } = await import("../../bootstrap/factory.js");
  const { migrateHomeDir } = await import("../../bootstrap/migrate.js");
  const { awaitQdrantReadiness } = await import("./qdrant-readiness.js");

  migrateHomeDir();
  // Bounded qdrant-readiness gate (2nfdm): after an embedded-daemon restart,
  // shard recovery blocks the HTTP bind for up to minutes — the run must WAIT
  // (streaming the daemon state to the renderer), not die on
  // INFRA_QDRANT_RECOVERING. Both context creation and the first cheap qdrant
  // probe go through the gate; a `ready` event closes the state line once any
  // wait actually happened.
  let waitedForQdrant = false;
  const readinessStart = Date.now();
  const onWait = (state: "starting" | "recovering", elapsedMs: number): void => {
    waitedForQdrant = true;
    send({ type: "qdrant-state", state, elapsedMs });
  };

  // Surface a one-time "Migrating to TurboQuant" phase: the startup reconcile in
  // createAppContext migrates any pre-turbo collection and polls the optimizer
  // pass, forwarding each progress event to the supervisor over the same IPC
  // channel as embedding/enrichment progress.
  const ctx = await awaitQdrantReadiness(
    async () =>
      createAppContext(parseAppConfig(), {
        onTurboMigration: (event) => {
          send({
            type: "turbo-migration",
            collection: event.collection,
            stage: event.stage,
            ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}),
          });
        },
      }),
    { onWait },
  ).catch((error: unknown) => {
    // Context creation failed terminally (readiness window exhausted or a
    // non-readiness fatal) — without this, the fatal would hit the uncaught
    // handler and exit silently in --json mode.
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(typeof (error as { code?: unknown } | null)?.code === "string"
        ? { code: (error as { code: string }).code }
        : {}),
    });
    process.exit(1);
  });
  try {
    // Cheap qdrant round-trip: the first real qdrant call of the run happens
    // deep inside indexCodebase — probe here instead so a recovering daemon is
    // awaited BEFORE any pipeline state is touched.
    await awaitQdrantReadiness(async () => ctx.app.listCollections(), { onWait });
    if (waitedForQdrant) {
      send({ type: "qdrant-state", state: "ready", elapsedMs: Date.now() - readinessStart });
    }
    const outcome = await runIndexWorker(ctx.app, path, options, send);
    ctx.cleanup?.();
    process.exit(outcome.failed.length > 0 ? 1 : 0);
  } catch (error) {
    send({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
      ...(typeof (error as { code?: unknown } | null)?.code === "string"
        ? { code: (error as { code: string }).code }
        : {}),
    });
    try {
      ctx.cleanup?.();
    } catch {
      // best-effort cleanup
    }
    process.exit(1);
  }
}
