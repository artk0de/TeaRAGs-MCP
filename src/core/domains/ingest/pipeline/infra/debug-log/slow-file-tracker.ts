/**
 * Per-file ingestion telemetry and the slowest-file leaderboard built from it.
 *
 * Split out of `debug-logger.ts`: the logger owns "when is something worth
 * writing down", this owns "which files were worth writing down" — a bounded
 * ranking with its own eviction rule, changing for reasons the log format never
 * shares.
 */

/**
 * Per-file ingestion telemetry record emitted by FileProcessor.
 * Used for post-mortem analysis — "which files were slowest to parse?".
 */
export interface FileIngestRecord {
  /** Relative path from basePath. */
  path: string;
  language: string;
  /** File size in bytes (UTF-8). 0 for errors before read. */
  bytes: number;
  /** Number of chunks produced. 0 if skipped. */
  chunks: number;
  /** Parse duration in ms. 0 if skipped before parsing. */
  parseMs: number;
  skipped?: boolean;
  skipReason?: "secrets" | "chunk-limit" | "error" | "delete-failed" | "quarantined" | "compiled";
}

/**
 * Tracks the top-N slowest non-skipped files by parseMs within a session.
 *
 * Skipped files (secrets, chunk-limit, errors) do not compete for the slow-file
 * heap — they carry their own signal in the FILE_INGESTED event and would
 * distort "slowest" semantics.
 */
export class SlowFileTracker {
  private readonly heap: FileIngestRecord[] = [];
  private readonly capacity: number;

  constructor(capacity = 20) {
    this.capacity = capacity;
  }

  record(entry: FileIngestRecord): void {
    if (entry.skipped) return;
    this.heap.push(entry);
    this.heap.sort((a, b) => b.parseMs - a.parseMs);
    if (this.heap.length > this.capacity) {
      this.heap.length = this.capacity;
    }
  }

  snapshot(): readonly FileIngestRecord[] {
    return [...this.heap];
  }

  reset(): void {
    this.heap.length = 0;
  }
}
