/**
 * WorkingTreeRowCache (WTO unbounded delta) — the in-memory rows of tree
 * files, bounded by the bytes of the rows' content rather than by a file
 * count: a delta has no file cap any more, so a count bound no longer bounds
 * memory. The least recently used entry is evicted first; an entry larger than
 * the whole bound is not held at all.
 */

import type { ScrollChunk } from "../chunk-grouping/types.js";

/** Default bound of one row cache: 64 MB of row content. */
export const WORKING_TREE_ROW_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/** UTF-8 bytes of the content the rows carry — what a row cache is bounded by. */
export function workingTreeRowBytes(rows: readonly ScrollChunk[]): number {
  let bytes = 0;
  for (const row of rows) {
    const { content } = row.payload;
    if (typeof content === "string") bytes += Buffer.byteLength(content, "utf8");
  }
  return bytes;
}

export class WorkingTreeRowCache<V> {
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private heldBytes = 0;

  constructor(private readonly maxBytes: number = WORKING_TREE_ROW_CACHE_MAX_BYTES) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // Re-insert: Map iteration order is the eviction order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    for (const [oldest, entry] of this.entries) {
      if (this.heldBytes + bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.heldBytes -= entry.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.heldBytes += bytes;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.heldBytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.heldBytes = 0;
  }
}
