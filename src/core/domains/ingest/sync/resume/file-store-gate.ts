/**
 * Marks a file done in the first-index resume checkpoint only after the run
 * has both submitted it and observed that many successful upserts.
 *
 * Chunk upserts can land before `onFileProcessed` runs, so stored counts are
 * kept until the submit arrives. A file that produced no chunks is done at
 * submit — there is no upsert to wait for. A file that was never submitted
 * stays out of the checkpoint even if points for it were stored. Saves are
 * serialized: concurrent files must not interleave `meta.json` updates.
 */

import type { FileMetadata } from "../snapshot/sharded-snapshot.js";

export interface ResumeCheckpointWriter {
  save: (files: ReadonlyMap<string, FileMetadata>) => Promise<void>;
}

export class FileStoreGate {
  private readonly submitted = new Map<string, number>();
  private readonly stored = new Map<string, number>();
  private readonly done = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private writeError: Error | undefined;

  constructor(
    private readonly writer: ResumeCheckpointWriter,
    private readonly metadata: ReadonlyMap<string, FileMetadata>,
  ) {}

  onFileSubmitted(relativePath: string, chunkCount: number): void {
    this.submitted.set(relativePath, chunkCount);
    this.maybePersist(relativePath);
  }

  onChunksStored(relativePaths: readonly string[]): void {
    for (const relativePath of relativePaths) {
      this.stored.set(relativePath, (this.stored.get(relativePath) ?? 0) + 1);
      this.maybePersist(relativePath);
    }
  }

  /** Resolves when every checkpoint save queued so far has finished. */
  async settled(): Promise<void> {
    await this.tail;
    if (this.writeError !== undefined) throw this.writeError;
  }

  private maybePersist(relativePath: string): void {
    if (this.done.has(relativePath)) return;
    const expected = this.submitted.get(relativePath);
    if (expected === undefined) return;
    if ((this.stored.get(relativePath) ?? 0) < expected) return;

    this.done.add(relativePath);
    const meta = this.metadata.get(relativePath);
    if (!meta || meta.hash.length === 0) return;

    const entry = new Map<string, FileMetadata>([[relativePath, meta]]);
    this.tail = this.tail
      .then(async () => this.writer.save(entry))
      .catch((error: unknown) => {
        this.writeError ??= error instanceof Error ? error : new Error(String(error));
      });
  }
}
