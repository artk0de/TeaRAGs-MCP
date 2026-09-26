/**
 * Byte-offset index over the pass-2 NDJSON spill (bd tea-rags-mcp-vtuu4).
 *
 * Pass-2 streams the spill in write order unless a resolver asks for another
 * order — TypeScript's closure batches, where each group of files is served
 * off one `ts.Program`. Visiting in that order means reading lines out of
 * sequence, so the spill is scanned once for where each line sits and which
 * file it belongs to, and each line is read back by offset when its turn
 * comes. Only offsets are held, never the lines, so the index costs a few
 * numbers per file rather than the spill's size.
 */

import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";

const NEWLINE = 0x0a;

/** One non-empty spill line: whose it is and where its bytes are. */
export interface SpillLineSpan {
  /** `relPath` of the line's extraction, or `""` when the line does not parse. */
  readonly relPath: string;
  readonly offset: number;
  readonly length: number;
}

/**
 * Every non-empty line of `spillPath`, in file order.
 *
 * A line that does not parse keeps its place with an empty `relPath`, so the
 * caller reads it back like any other and reports the parse failure where the
 * streaming path would have.
 */
export async function indexSpillLines(spillPath: string): Promise<SpillLineSpan[]> {
  const spans: SpillLineSpan[] = [];
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let lineStart = 0;
  let position = 0;

  const closeLine = (tail: Buffer): void => {
    const line = pendingLength === 0 ? tail : Buffer.concat([...pending, tail]);
    pending = [];
    pendingLength = 0;
    if (line.length === 0) return;
    spans.push({ relPath: relPathOf(line.toString("utf8")), offset: lineStart, length: line.length });
  };

  for await (const chunk of createReadStream(spillPath) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let newline = chunk.indexOf(NEWLINE, from); newline !== -1; newline = chunk.indexOf(NEWLINE, from)) {
      closeLine(chunk.subarray(from, newline));
      from = newline + 1;
      lineStart = position + from;
    }
    if (from < chunk.length) {
      pending.push(chunk.subarray(from));
      pendingLength += chunk.length - from;
    }
    position += chunk.length;
  }
  if (pendingLength > 0) closeLine(Buffer.alloc(0));
  return spans;
}

/** Reads indexed spill lines back by offset. Close it when done. */
export class SpillLineReader {
  private constructor(private readonly handle: FileHandle) {}

  static async open(spillPath: string): Promise<SpillLineReader> {
    return new SpillLineReader(await open(spillPath, "r"));
  }

  async read(span: SpillLineSpan): Promise<string> {
    const buffer = Buffer.allocUnsafe(span.length);
    await this.handle.read(buffer, 0, span.length, span.offset);
    return buffer.toString("utf8");
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

function relPathOf(line: string): string {
  try {
    const parsed = JSON.parse(line) as { relPath?: unknown };
    return typeof parsed.relPath === "string" ? parsed.relPath : "";
  } catch {
    return "";
  }
}
