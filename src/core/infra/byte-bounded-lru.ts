/**
 * ByteBoundedLru — an in-memory least-recently-used map bounded by the bytes
 * its entries declare, not by how many entries it holds. A count bound only
 * bounds memory when the population it was sized for is bounded; the
 * working-tree overlay's delta has no file cap, so its caches bound bytes.
 *
 * The caller states each entry's bytes (what it counts is the caller's
 * contract). A read is a use: the least recently set OR read entry is evicted
 * first. An entry larger than the whole bound is not held at all, and setting
 * it drops what its key held before.
 *
 * Stays in `infra`: the explore domain (row cache, dense vectors) and the api
 * layer (tree-graph content-hash memo) both hold one.
 */
export class ByteBoundedLru<V> {
  /** Map iteration order is the eviction order: the first key is the least recently used. */
  private readonly entries = new Map<string, { value: V; bytes: number }>();
  private held = 0;

  constructor(private readonly maxBytes: number) {}

  /** Bytes the held entries declared — the quantity the bound applies to. */
  get heldBytes(): number {
    return this.held;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    for (const [oldest, entry] of this.entries) {
      if (this.held + bytes <= this.maxBytes) break;
      this.entries.delete(oldest);
      this.held -= entry.bytes;
    }
    this.entries.set(key, { value, bytes });
    this.held += bytes;
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
