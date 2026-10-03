/**
 * WorkingTreeRowCache (WTO unbounded delta) — the in-memory rows of tree
 * files, bounded by the bytes of the rows' content rather than by a file
 * count: a delta has no file cap any more, so a count bound no longer bounds
 * memory. The least recently used entry is evicted first; an entry larger than
 * the whole bound is not held at all.
 */

import { ByteBoundedLru } from "../../../infra/byte-bounded-lru.js";
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

/** A {@link ByteBoundedLru} whose bound defaults to {@link WORKING_TREE_ROW_CACHE_MAX_BYTES}. */
export class WorkingTreeRowCache<V> extends ByteBoundedLru<V> {
  constructor(maxBytes: number = WORKING_TREE_ROW_CACHE_MAX_BYTES) {
    super(maxBytes);
  }
}

/**
 * WorkingTreePassRowCache — the chunk layer's row cache: byte-bounded like
 * {@link WorkingTreeRowCache}, but scan-resistant. Every `chunk` call walks the
 * whole delta in one pass; when the delta's rows exceed the bound, a plain LRU
 * evicts each entry before the next pass reaches it again — a 0% hit rate on a
 * warm, unchanged delta (live: 3,420 files, every one re-read from the store on
 * every request).
 *
 * A caller brackets its lookups in a pass (`beginPass` / `endPass`); an entry
 * remembers the last pass that used it. A miss evicts, least recently used
 * first, only entries no pass in flight has used; when that cannot free room it
 * is not admitted and evicts nothing. So a pass over a working set larger than
 * the bound keeps the resident set the previous passes built — repeated passes
 * hit about bound/workingSet of the files — while an entry no pass uses any more
 * (a superseded content version, another tree's rows) is evictable from the next
 * pass on.
 */
export class WorkingTreePassRowCache<V> {
  /** Map iteration order is the eviction order: the first key is the least recently used. */
  private readonly entries = new Map<string, { value: V; bytes: number; pass: number }>();
  private readonly passesInFlight = new Set<number>();
  private held = 0;
  private lastPass = 0;

  constructor(private readonly maxBytes: number = WORKING_TREE_ROW_CACHE_MAX_BYTES) {}

  /** Bytes the held entries declared — the quantity the bound applies to. */
  get heldBytes(): number {
    return this.held;
  }

  /** Opens a pass; its entries stay held until {@link endPass}. */
  beginPass(): number {
    this.lastPass++;
    this.passesInFlight.add(this.lastPass);
    return this.lastPass;
  }

  endPass(pass: number): void {
    this.passesInFlight.delete(pass);
  }

  /** The value under `key`, marked used by `pass`; undefined on a miss. */
  get(key: string, pass: number): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, { ...entry, pass });
    return entry.value;
  }

  /**
   * Holds `value` under `key` for `pass`, evicting entries no pass in flight
   * used. False — and nothing evicted — when the bound cannot make room.
   */
  set(key: string, value: V, bytes: number, pass: number): boolean {
    this.delete(key);
    if (bytes > this.maxBytes) return false;
    const evictable: string[] = [];
    let freed = 0;
    for (const [candidate, entry] of this.entries) {
      if (this.held - freed + bytes <= this.maxBytes) break;
      if (this.passesInFlight.has(entry.pass)) continue;
      evictable.push(candidate);
      freed += entry.bytes;
    }
    if (this.held - freed + bytes > this.maxBytes) return false;
    for (const candidate of evictable) this.delete(candidate);
    this.entries.set(key, { value, bytes, pass });
    this.held += bytes;
    return true;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.held -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.held = 0;
  }
}
