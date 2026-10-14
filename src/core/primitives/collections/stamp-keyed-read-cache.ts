/**
 * Whole-database reads held by a long-lived process (bd tea-rags-mcp-lnor0,
 * generalising nehn5's indexed-symbol-rows cache): DDG reviews per commit from
 * one MCP server, and the reads that depend only on the index — the file
 * dependency graph, the co-change graph, the symbol table — are the review's
 * most expensive. An entry lives under a (scope, read kind, key) slot and is
 * valid only for the write stamp it was read under; the caller supplies the
 * stamp, which must move on every committed write.
 *
 * Rules, shared by every read held here:
 * - the stamp is taken BEFORE the read, so a write committing while the read is
 *   in flight leaves the entry under the older stamp and the next caller reads
 *   again;
 * - one stamp per scope: a new stamp drops every read the scope held;
 * - a failed read is never held; no stamp means no caching;
 * - memory is bounded — `maxKeysPerKind` keys per (scope, kind) and `maxScopes`
 *   scopes, each evicting the least recently read.
 *
 * The cache hands every caller the SAME value, so a held value must be
 * immutable — freeze it in `load` (`deepFreeze`).
 */

/** Where one read is held: the database (`scope`), the read, and the read's arguments. */
export interface StampKeyedReadSlot {
  scope: string;
  kind: string;
  /** The read's arguments, serialised; absent for a read that takes none. */
  key?: string;
}

export interface StampKeyedReadCacheOptions {
  /** Keys one read kind holds per scope (default 4). */
  maxKeysPerKind?: number;
  /** Scopes held at once (default 4) — a superseded collection generation ages out. */
  maxScopes?: number;
}

interface StampedScopeReads {
  stamp: string;
  /** kind → key → the read; Map order is recency order. */
  kinds: Map<string, Map<string, Promise<unknown>>>;
}

const DEFAULT_MAX_KEYS_PER_KIND = 4;
const DEFAULT_MAX_SCOPES = 4;

export class StampKeyedReadCache {
  private readonly scopes = new Map<string, StampedScopeReads>();
  private readonly maxKeysPerKind: number;
  private readonly maxScopes: number;

  constructor(options: StampKeyedReadCacheOptions = {}) {
    this.maxKeysPerKind = options.maxKeysPerKind ?? DEFAULT_MAX_KEYS_PER_KIND;
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
  }

  /**
   * The read held in `slot` under `stamp`, else `load()`'s — held from the
   * moment it starts, so concurrent callers share one read.
   */
  async read<T>(slot: StampKeyedReadSlot, stamp: string | undefined, load: () => Promise<T>): Promise<T> {
    if (stamp === undefined) return load();
    const reads = this.kindReads(slot, stamp);
    const key = slot.key ?? "";
    const held = reads.get(key);
    if (held !== undefined) {
      reads.delete(key);
      reads.set(key, held);
      return held as Promise<T>;
    }
    const read = (async () => load())();
    reads.set(key, read);
    if (reads.size > this.maxKeysPerKind) reads.delete(reads.keys().next().value as string);
    read.catch(() => {
      if (reads.get(key) === read) reads.delete(key);
    });
    return read;
  }

  /** The `slot.kind` reads of `slot.scope` under `stamp`, the scope reset when its stamp moved. */
  private kindReads(slot: StampKeyedReadSlot, stamp: string): Map<string, Promise<unknown>> {
    let scope = this.scopes.get(slot.scope);
    this.scopes.delete(slot.scope);
    if (scope?.stamp !== stamp) scope = { stamp, kinds: new Map() };
    this.scopes.set(slot.scope, scope);
    if (this.scopes.size > this.maxScopes) this.scopes.delete(this.scopes.keys().next().value as string);
    let reads = scope.kinds.get(slot.kind);
    if (reads === undefined) {
      reads = new Map();
      scope.kinds.set(slot.kind, reads);
    }
    return reads;
  }
}

/**
 * Freeze every plain object and array reachable from `value`, and return it —
 * a consumer that mutates a shared value then throws instead of corrupting it
 * for the next. A `Map`/`Set` inside stays mutable at runtime (freezing does
 * not reach its entries): type it `ReadonlyMap`/`ReadonlySet`.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
