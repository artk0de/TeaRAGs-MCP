import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";

import type { DeterministicSkipReason, SkippedFilesSummary } from "../../../types.js";

/*
 * Reasons (`DeterministicSkipReason`, declared beside the status DTO): only a
 * content change (re-ingest) or a rebuild clears an entry.
 * - `secretsGate` — credential-looking content in a non-test file.
 * - `compiled` — a compiled JS bundle that slipped past the path ignores.
 * - `emptyFile` — blank (whitespace-only) content, so no chunk exists.
 */

/** One deliberately skipped file. Stable on-disk contract. */
export interface SkippedFileEntry {
  reason: DeterministicSkipReason;
  /** sha256 of the content the verdict was taken on (`fileContentHash`). */
  contentHash: string;
  recordedAt: string;
}

/** On-disk shape of `<collection>.skipped.json`. */
interface SkippedFileRecord {
  version: 1;
  updatedAt: string;
  files: Record<string, SkippedFileEntry>;
}

/**
 * Persists the files ingest skipped on purpose, so a snapshot-vs-Qdrant
 * consistency check can tell a deliberate skip from a lost file
 * (bd tea-rags-mcp-6xdwe / muj77).
 *
 * Placement and atomicity mirror `QuarantineStore`: the file is a SIBLING of the
 * collection's snapshot directory (`<snapshotDir>/<collection>.skipped.json`),
 * because `ShardedSnapshotManager` atomically swaps `<collection>/` on every
 * save; writes go tmp + rename. Kept separate from the quarantine on purpose:
 * quarantined paths are retried every pass, deterministic skips must not be.
 *
 * Mutations serialize through a write chain and work on a map cached after the
 * first load, so `clear` — called for every successfully ingested file — costs
 * no I/O for a path that was never skipped. Concurrent PROCESSES are
 * last-rename-wins, the same accepted design as the quarantine.
 */
export class SkippedFileStore {
  private readonly snapshotDir: string;
  private readonly skippedPath: string;
  private writeChain: Promise<unknown> = Promise.resolve();
  /** Map as of the last load/persist by THIS instance; loaded lazily under the write chain. */
  private cached?: Map<string, SkippedFileEntry>;

  constructor(snapshotDir: string, collectionName: string) {
    this.snapshotDir = snapshotDir;
    this.skippedPath = join(snapshotDir, `${collectionName}.skipped.json`);
  }

  /** Read the full map from disk. Empty map if the file is absent or corrupted. */
  async load(): Promise<Map<string, SkippedFileEntry>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.skippedPath, "utf-8");
    } catch {
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw) as SkippedFileRecord;
      return new Map(Object.entries(parsed.files ?? {}));
    } catch {
      return new Map();
    }
  }

  /** Deliberately-skipped relative paths — what a snapshot-vs-points probe subtracts before calling a file lost. */
  async paths(): Promise<Set<string>> {
    return new Set((await this.load()).keys());
  }

  /** Record (or overwrite) one skipped path. */
  async record(path: string, reason: DeterministicSkipReason, contentHash: string): Promise<void> {
    await this.mutate((entries) => {
      entries.set(path, { reason, contentHash, recordedAt: new Date().toISOString() });
      return true;
    });
  }

  /** Drop one path — it ingested with points. No write when it was never skipped. */
  async clear(path: string): Promise<void> {
    await this.mutate((entries) => entries.delete(path));
  }

  /** Drop several paths in one write (deleted / newly ignored files). */
  async clearMany(paths: Iterable<string>): Promise<void> {
    await this.mutate((entries) => {
      let changed = false;
      for (const path of paths) changed = entries.delete(path) || changed;
      return changed;
    });
  }

  /** Drop every entry (forceReindex / schema-drift rebuild / clearIndex / footprint remove). */
  async clearAll(): Promise<void> {
    await this.enqueue(async () => {
      await fs.rm(this.skippedPath, { force: true });
      this.cached = new Map();
    });
  }

  /** Copy this collection's file to targetCollection. No-op when absent. */
  async cloneTo(targetCollection: string): Promise<void> {
    const to = join(this.snapshotDir, `${targetCollection}.skipped.json`);
    try {
      await fs.copyFile(this.skippedPath, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Count by reason; `sample` (first paths by path order) only when
   * `sampleLimit` > 0. Undefined when nothing is skipped.
   */
  async summarize(opts: { sampleLimit?: number } = {}): Promise<SkippedFilesSummary | undefined> {
    const entries = await this.load();
    if (entries.size === 0) return undefined;
    const byReason: Partial<Record<DeterministicSkipReason, number>> = {};
    for (const { reason } of entries.values()) byReason[reason] = (byReason[reason] ?? 0) + 1;
    const summary: SkippedFilesSummary = { count: entries.size, byReason };
    const sampleLimit = opts.sampleLimit ?? 0;
    if (sampleLimit > 0) {
      summary.sample = [...entries]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, sampleLimit)
        .map(([path, { reason }]) => ({ path, reason }));
    }
    return summary;
  }

  private async enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op, op);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Apply `change` to the cached map; persist only when it reports a change. */
  private async mutate(change: (entries: Map<string, SkippedFileEntry>) => boolean): Promise<void> {
    await this.enqueue(async () => {
      this.cached ??= await this.load();
      if (change(this.cached)) await this.persist(this.cached);
    });
  }

  private async persist(entries: Map<string, SkippedFileEntry>): Promise<void> {
    if (entries.size === 0) {
      await fs.rm(this.skippedPath, { force: true });
      return;
    }
    const skippedFileRecord: SkippedFileRecord = {
      version: 1,
      updatedAt: new Date().toISOString(),
      files: Object.fromEntries(entries),
    };
    await fs.mkdir(this.snapshotDir, { recursive: true });
    const tmpPath = `${this.skippedPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(skippedFileRecord, null, 2), "utf-8");
    await fs.rename(tmpPath, this.skippedPath);
  }
}
