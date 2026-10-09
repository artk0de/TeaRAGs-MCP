/**
 * One NDJSON spill stream of a codegraph run (bd tea-rags-mcp-89k7k.35.16).
 *
 * Lifted out of `createCodegraphExtractionSink` so the sink keeps the pass-1
 * persist / seal / pass-2 dispatch and a new spilled row family (e.g. a
 * field-access edge table) is one more writer instance, not more sink body.
 *
 * Lifecycle: `append` opens lazily — directory, `.live` claim, write stream —
 * on the first row; `close` ends the stream before a reader opens the file;
 * `appendAfterClose` adds rows to the closed file; `cleanup` removes the file
 * and its claim, best-effort. Every I/O failure surfaces as a
 * `CodegraphSpillIoError` naming the spill and the operation.
 */

import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { appendFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";

import { spillLiveMarkerPath } from "../../../../contracts/types/codegraph-spill.js";
import type { FileExtraction } from "../../../../contracts/types/codegraph.js";
import { CodegraphSpillIoError } from "../../errors.js";

export class CodegraphExtractionSpillWriter<Row = FileExtraction> {
  private stream: WriteStream | null = null;
  private rowsWritten = 0;

  constructor(readonly spillPath: string) {}

  /** Rows that reached the spill, through either append path. */
  get rowCount(): number {
    return this.rowsWritten;
  }

  /** Append one row as one NDJSON line, honoring the stream's back-pressure
   * before returning. Opens the spill on the first call. */
  async append(row: Row): Promise<void> {
    const stream = await this.ensureStream();
    const ok = stream.write(serializeSpillRow(row));
    if (!ok) {
      // Back-pressure — wait for the drain event before the next write
      // returns. Prevents a fast walker from filling the OS pipe and
      // ballooning kernel buffers.
      try {
        await once(stream, "drain");
      } catch (err) {
        throw new CodegraphSpillIoError(this.spillPath, "write", err instanceof Error ? err : undefined);
      }
    }
    this.rowsWritten += 1;
  }

  /** Append rows to a spill whose write stream is already closed. */
  async appendAfterClose(rows: readonly Row[]): Promise<void> {
    try {
      await appendFile(this.spillPath, rows.map(serializeSpillRow).join(""), "utf8");
    } catch (err) {
      throw new CodegraphSpillIoError(this.spillPath, "write", err instanceof Error ? err : undefined);
    }
    this.rowsWritten += rows.length;
  }

  /** Close the writable end before the reader opens it. No-op when never opened. */
  async close(): Promise<void> {
    const streamToClose = this.stream;
    if (!streamToClose) return;
    // `end` takes a callback and finishes the file with a final flush.
    await new Promise<void>((resolve, reject) => {
      streamToClose.end((err?: Error | null) => {
        if (err) reject(new CodegraphSpillIoError(this.spillPath, "write", err));
        else resolve();
      });
    });
  }

  /**
   * Best-effort: unlink the spill regardless of success/failure so a failed
   * run does not leak GBs of NDJSON. ENOENT means a prior cleanup already
   * happened (idempotent), all other errors are swallowed because the pool
   * init re-purges on next process start anyway. The marker goes with it —
   * left behind, it would pin a spill that no longer exists to a pid that
   * outlives it.
   */
  async cleanup(): Promise<void> {
    await rm(this.spillPath, { force: true }).catch(() => undefined);
    await rm(spillLiveMarkerPath(this.spillPath), { force: true }).catch(() => undefined);
  }

  private async ensureStream(): Promise<WriteStream> {
    if (this.stream) return this.stream;
    try {
      await mkdir(pathDirname(this.spillPath), { recursive: true });
      // Claim the spill BEFORE it exists (bd tea-rags-mcp-v6gxr). Every pool
      // built while this run is in flight — an unpinned fan-out worker's, the
      // daemon's, a second CLI run's — sweeps this directory on construction,
      // and the marker's pid is the only thing that tells it apart from the
      // residue of a crashed run. Written first so the ordering never leaves an
      // unclaimed spill on disk. `spillLiveMarkerPath` is the pool's, so the
      // writer and the sweeper cannot disagree about the name.
      await writeFile(spillLiveMarkerPath(this.spillPath), `${process.pid}`, "utf8");
      this.stream = createWriteStream(this.spillPath, { encoding: "utf8" });
    } catch (err) {
      throw new CodegraphSpillIoError(this.spillPath, "open", err instanceof Error ? err : undefined);
    }
    return this.stream;
  }
}

/** The spill line format pass-2 reads: one JSON document per `\n`-terminated line. */
function serializeSpillRow(row: unknown): string {
  return `${JSON.stringify(row)}\n`;
}
