// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * The context window a GGUF model was trained for, read from the file's own
 * header metadata (`<general.architecture>.context_length`).
 *
 * Reads the key/value section only — never the tensor infos or tensor data
 * behind it — through a bounded window over the file. GGUF v2 and v3 (64-bit
 * counts and lengths); v1 and anything unreadable answer `undefined`.
 */

import { open, type FileHandle } from "node:fs/promises";

const GGUF_MAGIC = "GGUF";
const READ_WINDOW_BYTES = 1024 * 1024;
/** The KV section carries the tokenizer vocabulary — a few MiB; a header past this is not one we read. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

const TYPE_STRING = 8;
const TYPE_ARRAY = 9;
/** Byte width of each fixed-size GGUF value type, by type id. */
const FIXED_WIDTH: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

class HeaderOverrunError extends Error {}

/** Sequential reader over a file handle; reads only the bytes it is asked for, never past MAX_HEADER_BYTES. */
class GgufCursor {
  private window = Buffer.alloc(0);
  private windowStart = 0;
  private pos = 0;

  constructor(private readonly handle: FileHandle) {}

  async bytes(length: number): Promise<Buffer> {
    const end = this.pos + length;
    if (end > MAX_HEADER_BYTES) throw new HeaderOverrunError();
    if (this.pos < this.windowStart || end > this.windowStart + this.window.length) {
      const size = Math.max(length, READ_WINDOW_BYTES);
      const buf = Buffer.alloc(size);
      const { bytesRead } = await this.handle.read(buf, 0, size, this.pos);
      this.window = buf.subarray(0, bytesRead);
      this.windowStart = this.pos;
      if (bytesRead < length) throw new HeaderOverrunError();
    }
    const offset = this.pos - this.windowStart;
    this.pos = end;
    return this.window.subarray(offset, offset + length);
  }

  skip(length: number): void {
    if (this.pos + length > MAX_HEADER_BYTES) throw new HeaderOverrunError();
    this.pos += length;
  }

  async u32(): Promise<number> {
    return (await this.bytes(4)).readUInt32LE(0);
  }

  async u64(): Promise<number> {
    const value = (await this.bytes(8)).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new HeaderOverrunError();
    return Number(value);
  }

  async string(): Promise<string> {
    return (await this.bytes(await this.u64())).toString("utf8");
  }
}

/** An integer or string value; arrays and floats are skipped and answer `undefined`. */
async function readValue(cursor: GgufCursor, type: number): Promise<number | string | undefined> {
  if (type === TYPE_STRING) return cursor.string();
  if (type === TYPE_ARRAY) {
    const itemType = await cursor.u32();
    const count = await cursor.u64();
    if (itemType === TYPE_STRING) {
      for (let i = 0; i < count; i++) cursor.skip(await cursor.u64());
      return undefined;
    }
    if (itemType === TYPE_ARRAY) throw new HeaderOverrunError();
    cursor.skip(count * widthOf(itemType));
    return undefined;
  }
  const bytes = await cursor.bytes(widthOf(type));
  switch (type) {
    case 0:
      return bytes.readUInt8(0);
    case 2:
      return bytes.readUInt16LE(0);
    case 4:
      return bytes.readUInt32LE(0);
    case 5:
      return bytes.readInt32LE(0);
    case 10:
      return Number(bytes.readBigUInt64LE(0));
    case 11:
      return Number(bytes.readBigInt64LE(0));
    default:
      return undefined;
  }
}

function widthOf(type: number): number {
  const width = FIXED_WIDTH[type];
  if (width === undefined) throw new HeaderOverrunError();
  return width;
}

async function scanContextLength(cursor: GgufCursor): Promise<number | undefined> {
  if ((await cursor.bytes(4)).toString("ascii") !== GGUF_MAGIC) return undefined;
  const version = await cursor.u32();
  if (version < 2) return undefined;
  await cursor.u64(); // tensor count — the tensors themselves are never read
  const kvCount = await cursor.u64();

  let architecture: string | undefined;
  const contextLengths = new Map<string, number>();
  for (let i = 0; i < kvCount; i++) {
    const key = await cursor.string();
    const value = await readValue(cursor, await cursor.u32());
    if (key === "general.architecture" && typeof value === "string") architecture = value;
    else if (key.endsWith(".context_length") && typeof value === "number") contextLengths.set(key, value);
    if (architecture !== undefined && contextLengths.has(`${architecture}.context_length`)) break;
  }
  return architecture === undefined ? undefined : contextLengths.get(`${architecture}.context_length`);
}

/** `<general.architecture>.context_length` of the GGUF at `path`; `undefined` when absent or unreadable. */
export async function readGgufContextLength(path: string): Promise<number | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch {
    return undefined;
  }
  try {
    return await scanContextLength(new GgufCursor(handle));
  } catch {
    // A truncated or oversized header, or a path that is not a regular file.
    return undefined;
  } finally {
    await handle.close();
  }
}
