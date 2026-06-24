import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import type { ErrorCode } from "../../../contracts/errors.js";
import type { QuarantinableIngestError, QuarantinePhase } from "../errors.js";

/**
 * One quarantined file: why it failed, where in the pipeline, and how often.
 * Stable on-disk contract consumed by `tea-rags doctor <project> --quarantine`.
 */
export interface QuarantineEntry {
  errorCode: ErrorCode;
  errorMessage: string;
  phase: QuarantinePhase;
  firstFailedAt: string;
  lastFailedAt: string;
  attempts: number;
}

/** On-disk shape of quarantine.json. */
interface QuarantineFile {
  version: 1;
  updatedAt: string;
  files: Record<string, QuarantineEntry>;
}

/**
 * Persists poison-pill files that broke indexing so they are retried on every
 * subsequent pass instead of silently dropping out of the index. Writes are
 * atomic (tmp + rename).
 *
 * The file is a SIBLING of the collection's snapshot directory
 * (`<snapshotDir>/<collection>.quarantine.json`), NOT inside it: the sharded
 * snapshot manager atomically swaps the whole `<collection>/` directory on every
 * save, which would wipe a quarantine file written mid-pass. Living one level up
 * keeps it intact across snapshot saves while still being collection-scoped.
 */
export class QuarantineStore {
  private readonly snapshotDir: string;
  private readonly quarantinePath: string;
  /**
   * Serializes mutating operations. processFiles fails files concurrently, so
   * multiple markFailed calls race on the same read-modify-write; chaining them
   * prevents lost updates and tmp-file collisions on the atomic rename.
   */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(snapshotDir: string, collectionName: string) {
    this.snapshotDir = snapshotDir;
    this.quarantinePath = join(snapshotDir, `${collectionName}.quarantine.json`);
  }

  /** Run a mutating op after all previously-enqueued ones, regardless of their outcome. */
  private async enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(op, op);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Read full map. Empty map if the file is absent or corrupted. */
  async load(): Promise<Map<string, QuarantineEntry>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.quarantinePath, "utf-8");
    } catch {
      // Absent file — no files have failed yet.
      return new Map();
    }
    try {
      const parsed = JSON.parse(raw) as QuarantineFile;
      return new Map(Object.entries(parsed.files ?? {}));
    } catch {
      // Corrupted JSON — treat as empty rather than aborting the pass.
      return new Map();
    }
  }

  /** Mark a single file failed. Read-modify-write via tmp + rename. */
  async markFailed(path: string, err: QuarantinableIngestError): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.load();
      this.applyFailure(entries, path, err);
      await this.persist(entries);
    });
  }

  /** Mark a batch of files failed in one write (for worker-pool batch failures). */
  async markFailedBatch(paths: string[], err: QuarantinableIngestError): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.load();
      for (const path of paths) {
        this.applyFailure(entries, path, err);
      }
      await this.persist(entries);
    });
  }

  /** Remove a path on successful re-processing. No-op if it was not quarantined. */
  async clear(path: string): Promise<void> {
    await this.enqueue(async () => {
      const entries = await this.load();
      if (!entries.delete(path)) {
        return;
      }
      await this.persist(entries);
    });
  }

  /** Copy this collection's quarantine file to targetCollection. No-op when absent. */
  async cloneTo(targetCollection: string): Promise<void> {
    const to = join(this.snapshotDir, `${targetCollection}.quarantine.json`);
    try {
      await copyFile(this.quarantinePath, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /** Drop all entries (called on forceReindex / schema-drift reset). */
  async clearAll(): Promise<void> {
    await this.enqueue(async () => {
      await fs.rm(this.quarantinePath, { force: true });
    });
  }

  /** Count of quarantined files (for get_index_status). */
  async count(): Promise<number> {
    return (await this.load()).size;
  }

  /** Upsert a failure into the in-memory map: new entry or attempts++. */
  private applyFailure(entries: Map<string, QuarantineEntry>, path: string, err: QuarantinableIngestError): void {
    const now = new Date().toISOString();
    const existing = entries.get(path);
    entries.set(path, {
      errorCode: err.code,
      errorMessage: err.message,
      phase: err.phase,
      firstFailedAt: existing?.firstFailedAt ?? now,
      lastFailedAt: now,
      attempts: (existing?.attempts ?? 0) + 1,
    });
  }

  /** Atomically write the full map to quarantine.json. */
  private async persist(entries: Map<string, QuarantineEntry>): Promise<void> {
    const payload: QuarantineFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      files: Object.fromEntries(entries),
    };
    await fs.mkdir(this.snapshotDir, { recursive: true });
    // Unique tmp suffix so a write from another QuarantineStore instance for the
    // same collection (e.g. status count vs pipeline write) can't clobber ours.
    const tmpPath = `${this.quarantinePath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
    await fs.rename(tmpPath, this.quarantinePath);
  }
}
