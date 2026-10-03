/**
 * WorkingTreePassCache — a byte-bounded cache that a full pass over a working
 * set larger than its bound cannot flush. The working-tree overlay walks its
 * whole delta on every request (the chunk layer's rows, the dense floor's
 * vectors); when the delta exceeds the bound, a plain LRU evicts each entry
 * before the next pass reaches it again — a 0% hit rate on a warm, unchanged
 * delta (live: 3,420 files, every one re-read from the store on every request).
 *
 * A caller brackets its lookups in a pass (`beginPass` / `endPass`); an entry
 * remembers the last pass that used it. A miss evicts, least recently used
 * first, only entries no pass in flight has used; when that cannot free room it
 * is not admitted and evicts nothing. So a pass over a working set larger than
 * the bound keeps the resident set the previous passes built — repeated passes
 * hit about bound/workingSet of the entries — while an entry no pass uses any
 * more (a superseded content version, another tree's rows) is evictable from
 * the next pass on.
 *
 * Not a `ByteBoundedLru`: that one's plain LRU stays the contract of its
 * other users.
 */
export class WorkingTreePassCache<V> {
  /** Map iteration order is the eviction order: the first key is the least recently used. */
  private readonly entries = new Map<string, { value: V; bytes: number; pass: number }>();
  private readonly passesInFlight = new Set<number>();
  private held = 0;
  private lastPass = 0;

  constructor(private readonly maxBytes: number) {}

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
