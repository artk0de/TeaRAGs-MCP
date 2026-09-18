/**
 * Sweep of orphaned `index-codebase` workers (bd tea-rags-mcp-f924y).
 *
 * The parent-death guard stops a worker whose supervisor dies before handing it
 * off. What it cannot stop is a worker that was never registered with it (a
 * build from before the guard), one wedged past reacting, or one that WAS handed
 * off and then stopped making progress. Each of those keeps its collection's
 * indexing lock heartbeating, so every later run on the collection is refused.
 *
 * The sweep only ever stops a process it can PROVE is such a worker:
 *   1. the worker registered itself (`IndexWorkerRegistry`);
 *   2. the pid still names that process — its command line is an
 *      `index-codebase --__worker` and it started when the record says;
 *   3. its supervisor is gone — the worker was reparented.
 * A pid that fails 2 is a record left behind by a worker that exited; the record
 * is dropped and the process is never touched.
 *
 * Verdicts:
 *   attached — supervisor alive: a run in progress. Kept.
 *   detached — handed off, progressing: background enrichment. Kept.
 *   orphaned — supervisor gone, never handed off. Stopped.
 *   stalled  — handed off, no progress for `stalledAfterMs`. Reported; stopped
 *              only with `killStalled`, since a long daemon-side phase reports
 *              nothing either.
 *   gone     — no such worker any more. Record dropped.
 */

import { execFileSync } from "node:child_process";

import type { IndexWorkerRecord, IndexWorkerRegistry } from "./worker-registry.js";

export type IndexWorkerSweepVerdict = "attached" | "detached" | "orphaned" | "stalled" | "gone";

export type IndexWorkerSweepAction = "kept" | "killed" | "pruned" | "would-kill" | "would-prune" | "kill-failed";

export interface IndexWorkerSweepOutcome {
  record: IndexWorkerRecord;
  verdict: IndexWorkerSweepVerdict;
  action: IndexWorkerSweepAction;
}

/** What `ps` says about one pid right now. */
export interface IndexWorkerProcessSnapshot {
  ppid: number;
  pgid: number;
  startedAtMs: number;
  command: string;
}

/** The OS seam — `ps` + signals by default, injectable for tests. */
export interface IndexWorkerProcessProbe {
  /** `undefined` when no process holds the pid. */
  inspect: (pid: number) => IndexWorkerProcessSnapshot | undefined;
  /** Signal a pid, or a whole process group when given `-pgid`. */
  kill: (target: number, signal: NodeJS.Signals) => void;
}

export interface IndexWorkerSweepOptions {
  now?: () => number;
  /** No progress for this long makes a handed-off worker `stalled`. */
  stalledAfterMs?: number;
  /** Also stop `stalled` workers. */
  killStalled?: boolean;
  /** Only consider workers whose entry script lives under this path — one checkout's build. */
  entryScriptPrefix?: string;
  /** Report what would be stopped; stop and forget nothing. */
  dryRun?: boolean;
  /** How long a worker gets to exit on SIGTERM before SIGKILL, and on SIGKILL before giving up. */
  killGraceMs?: number;
}

/**
 * Half an hour without a progress message. Long daemon-side phases (cycles and
 * PageRank on a large graph) report nothing while they run, which is why a
 * stalled worker is not stopped unless asked.
 */
export const INDEX_WORKER_STALLED_AFTER_MS = 30 * 60_000;

const DEFAULT_KILL_GRACE_MS = 3_000;
const KILL_POLL_INTERVAL_MS = 50;

/** `ps` start times have one-second resolution; the worker records its own to the millisecond. */
const START_TIME_TOLERANCE_MS = 5_000;

export function classifyIndexWorker(
  record: IndexWorkerRecord,
  snapshot: IndexWorkerProcessSnapshot | undefined,
  nowMs: number,
  stalledAfterMs: number = INDEX_WORKER_STALLED_AFTER_MS,
): IndexWorkerSweepVerdict {
  if (!snapshot || !isSameWorkerProcess(record, snapshot)) return "gone";
  if (snapshot.ppid === record.supervisorPid) return "attached";
  if (record.handedOffAtMs === undefined) return "orphaned";
  return nowMs - record.lastProgressAtMs > stalledAfterMs ? "stalled" : "detached";
}

function isSameWorkerProcess(record: IndexWorkerRecord, snapshot: IndexWorkerProcessSnapshot): boolean {
  return (
    snapshot.command.includes("index-codebase") &&
    snapshot.command.includes("--__worker") &&
    Math.abs(snapshot.startedAtMs - record.startedAtMs) <= START_TIME_TOLERANCE_MS
  );
}

export async function sweepIndexWorkers(
  registry: IndexWorkerRegistry,
  probe: IndexWorkerProcessProbe,
  options: IndexWorkerSweepOptions = {},
): Promise<IndexWorkerSweepOutcome[]> {
  const now = options.now ?? Date.now;
  const outcomes: IndexWorkerSweepOutcome[] = [];
  for (const record of registry.list()) {
    if (options.entryScriptPrefix !== undefined && !record.entryScript.startsWith(options.entryScriptPrefix)) continue;
    const snapshot = probe.inspect(record.pid);
    const verdict = classifyIndexWorker(record, snapshot, now(), options.stalledAfterMs);
    const outcome = { record, verdict };

    if (verdict === "gone") {
      if (options.dryRun) {
        outcomes.push({ ...outcome, action: "would-prune" });
        continue;
      }
      registry.unregister(record.pid);
      outcomes.push({ ...outcome, action: "pruned" });
      continue;
    }
    const shouldStop = verdict === "orphaned" || (verdict === "stalled" && options.killStalled === true);
    if (!shouldStop || !snapshot) {
      outcomes.push({ ...outcome, action: "kept" });
      continue;
    }
    if (options.dryRun) {
      outcomes.push({ ...outcome, action: "would-kill" });
      continue;
    }
    const stopped = await stopWorker(record, snapshot, probe, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    if (stopped) registry.unregister(record.pid);
    outcomes.push({ ...outcome, action: stopped ? "killed" : "kill-failed" });
  }
  return outcomes;
}

/**
 * SIGTERM, then SIGKILL — to the worker's whole process group when it leads one
 * (a forked worker is detached, so it does, and its git / chunker children are
 * in it); to the pid alone otherwise. The daemons it may have spawned are
 * detached into groups of their own and are not reached.
 */
async function stopWorker(
  record: IndexWorkerRecord,
  snapshot: IndexWorkerProcessSnapshot,
  probe: IndexWorkerProcessProbe,
  graceMs: number,
): Promise<boolean> {
  const target = snapshot.pgid === record.pid ? -record.pid : record.pid;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      probe.kill(target, signal);
    } catch {
      /* raced its own exit — the wait below decides */
    }
    if (await waitUntilGone(record, probe, graceMs)) return true;
  }
  return false;
}

async function waitUntilGone(
  record: IndexWorkerRecord,
  probe: IndexWorkerProcessProbe,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    const snapshot = probe.inspect(record.pid);
    if (!snapshot || !isSameWorkerProcess(record, snapshot)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, KILL_POLL_INTERVAL_MS));
  }
}

/**
 * `ps -o ppid=,pgid=,lstart=,command= -p <pid>` — the same columns on macOS and
 * Linux. `lstart` is five tokens (`Fri Sep 18 14:03:12 2026`, local time). A
 * zombie reports as `<defunct>`, which fails the command check and so reads as
 * gone. Not available on Windows, where the sweep is not offered.
 */
export const psIndexWorkerProcessProbe: IndexWorkerProcessProbe = {
  inspect: (pid) => {
    let out: string;
    try {
      out = execFileSync("ps", ["-o", "ppid=,pgid=,lstart=,command=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return undefined;
    }
    const tokens = out.trim().split(/\s+/);
    if (tokens.length < 8) return undefined;
    const startedAtMs = Date.parse(tokens.slice(2, 7).join(" "));
    if (!Number.isFinite(startedAtMs)) return undefined;
    return {
      ppid: Number(tokens[0]),
      pgid: Number(tokens[1]),
      startedAtMs,
      command: tokens.slice(7).join(" "),
    };
  },
  kill: (target, signal) => {
    process.kill(target, signal);
  },
};
