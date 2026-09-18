/**
 * On-disk record of live `index-codebase` workers (bd tea-rags-mcp-f924y).
 *
 * Each worker writes one file about itself — `<dataDir>/workers/index-worker-<pid>.json`
 * — and removes it when it exits. What the file carries is what a sweep needs to
 * prove a pid is a tea-rags index worker and to judge it without guessing:
 * which supervisor forked it, when the process started (pid reuse), which build
 * it runs, whether it was handed off to run alone, and when it last made progress.
 *
 * Every operation is synchronous and best-effort-safe to call from an `exit`
 * handler, and dependency-free so the pre-build sweep can load it cheaply.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface IndexWorkerRecord {
  pid: number;
  /** The foreground CLI that forked the worker — its parent at registration. */
  supervisorPid: number;
  /** When the worker process started, epoch ms. With `pid`, names the process against pid reuse. */
  startedAtMs: number;
  /** The resolved CLI entry the worker runs — which build (checkout) it belongs to. */
  entryScript: string;
  /** The project being indexed. */
  projectPath: string;
  /** Set once the supervisor granted "outlive": from then on the worker runs without a parent by design. */
  handedOffAtMs?: number;
  /** The last time the worker reported progress. */
  lastProgressAtMs: number;
}

const RECORD_PREFIX = "index-worker-";
const RECORD_SUFFIX = ".json";

/** Where the registry lives for a data directory — `$TEA_RAGS_DATA_DIR`, else `~/.tea-rags`. */
export function indexWorkerRegistryDir(
  dataDir: string = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"),
): string {
  return join(dataDir, "workers");
}

export class IndexWorkerRegistry {
  constructor(readonly dir: string) {}

  register(record: IndexWorkerRecord): void {
    mkdirSync(this.dir, { recursive: true });
    this.write(record);
  }

  markHandedOff(pid: number, atMs: number): void {
    this.update(pid, { handedOffAtMs: atMs });
  }

  recordProgress(pid: number, atMs: number): void {
    this.update(pid, { lastProgressAtMs: atMs });
  }

  unregister(pid: number): void {
    try {
      unlinkSync(this.pathFor(pid));
    } catch {
      /* already gone */
    }
  }

  /** Every record that parses; a half-written or foreign file is skipped. */
  list(): IndexWorkerRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: IndexWorkerRecord[] = [];
    for (const name of names) {
      if (!name.startsWith(RECORD_PREFIX) || !name.endsWith(RECORD_SUFFIX)) continue;
      const parsed = this.read(join(this.dir, name));
      if (parsed) records.push(parsed);
    }
    return records;
  }

  /** Patch the worker's own record; a record already gone is not recreated. */
  private update(pid: number, patch: Partial<IndexWorkerRecord>): void {
    const current = this.read(this.pathFor(pid));
    if (!current) return;
    this.write({ ...current, ...patch });
  }

  private write(record: IndexWorkerRecord): void {
    const target = this.pathFor(record.pid);
    // Written aside and renamed in, so a sweep never reads half a record.
    const staging = `${target}.${process.pid}.tmp`;
    writeFileSync(staging, JSON.stringify(record));
    renameSync(staging, target);
  }

  private read(path: string): IndexWorkerRecord | undefined {
    try {
      return parseIndexWorkerRecord(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return undefined;
    }
  }

  private pathFor(pid: number): string {
    return join(this.dir, `${RECORD_PREFIX}${pid}${RECORD_SUFFIX}`);
  }
}

function parseIndexWorkerRecord(value: unknown): IndexWorkerRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const numeric = ["pid", "supervisorPid", "startedAtMs", "lastProgressAtMs"] as const;
  if (numeric.some((key) => typeof v[key] !== "number")) return undefined;
  if (typeof v.entryScript !== "string" || typeof v.projectPath !== "string") return undefined;
  if (v.handedOffAtMs !== undefined && typeof v.handedOffAtMs !== "number") return undefined;
  return {
    pid: v.pid as number,
    supervisorPid: v.supervisorPid as number,
    startedAtMs: v.startedAtMs as number,
    entryScript: v.entryScript,
    projectPath: v.projectPath,
    ...(v.handedOffAtMs !== undefined ? { handedOffAtMs: v.handedOffAtMs } : {}),
    lastProgressAtMs: v.lastProgressAtMs as number,
  };
}
