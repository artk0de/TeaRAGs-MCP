/**
 * Batch-shaped wrappers for the outline decoration resolvers (bd tea-rags-mcp-4qdj0).
 *
 * find_symbol `symbols[]` resolves every address through its own strategy, and
 * each strategy's outline render asks the container-ancestor and visibility
 * resolvers for ITS ids — one DuckDB daemon roundtrip per address per resolver
 * (the daemon socket serialises its clients), measured ~120ms/address on
 * taxdome-worktree-navmaster: a 17-address batch took 1.9-2.1s while every
 * single-address shape ran in 50-170ms.
 *
 * Both resolvers already accept id ARRAYS. Wrapping them per batch gives:
 *
 *  - **Prefetch** — one resolver call covering every id derivable from the
 *    batch's addresses (their containers: strip the `#member` tail, strip the
 *    last `::` segment), issued once before the drill starts.
 *  - **Cache** — per (collection, tree) id -> rows; repeat ids across
 *    addresses (same container outlined by several members) never re-fetch.
 *    Misses fall through to the inner resolver, so an id prefetch could not
 *    name costs one extra call, never a wrong answer.
 *
 * Ancestors are fully derivable, so a batch collapses their N calls into one.
 * Visibility asks for the CONTAINERS' MEMBERS, knowable only after each
 * address's rows render — those stay per-address, but the cache eats the
 * overlap and the derivable ids (the addresses and their containers
 * themselves) ride the prefetch.
 */

import type {
  ContainerAncestorResolver,
  InheritanceEdge,
  SymbolVisibilityResolver,
  SymbolVisibilityRow,
} from "../../contracts/types/codegraph.js";
import type { WorkingTreeGraphReader } from "../../contracts/types/working-tree.js";

/** Cache slot identity: rows read through a tree differ from index rows. */
interface CacheSlot<Row> {
  key: string;
  rows: Map<string, Row[]>;
}

/** Merge arrivals into one fetch wave for this long (ms) before departing. */
const WAVE_MS = 20;

/**
 * One id-addressed lookup over an array-returning resolver call, with a
 * per-(collection, tree) cache, a prefetch entry point, and a short departure
 * window that merges misses arriving from concurrently-resolving batch
 * addresses into one inner call. The daemon socket serialises its clients
 * anyway — N small requests cost N roundtrips there, one merged request costs
 * one.
 */
class BatchedLookup<Row> {
  private slot: CacheSlot<Row> | undefined;
  private waveIds: Set<string> | undefined;
  private waveTimer: ReturnType<typeof setTimeout> | undefined;
  private waveDone: Promise<void> | undefined;

  constructor(
    private readonly fetch: (
      collectionName: string,
      symbolIds: readonly string[],
      readTreeGraph?: WorkingTreeGraphReader,
    ) => Promise<Row[]>,
    private readonly rowIds: (row: Row) => readonly string[],
  ) {}

  /** Warm the cache with one inner call for `ids`; failures leave it empty. */
  async prefetch(
    collectionName: string,
    symbolIds: readonly string[],
    readTreeGraph?: WorkingTreeGraphReader,
  ): Promise<void> {
    if (symbolIds.length === 0) return;
    try {
      await this.fetchInto(collectionName, symbolIds, readTreeGraph, false);
    } catch {
      // Nothing reserved: a transient prefetch failure lets the first address
      // retry for real instead of degrading the whole batch on one blip.
    }
  }

  async resolve(
    collectionName: string,
    symbolIds: readonly string[],
    readTreeGraph?: WorkingTreeGraphReader,
  ): Promise<Row[]> {
    const wanted = [...new Set(symbolIds)];
    const slot = this.slotFor(collectionName, readTreeGraph);
    const missing = wanted.filter((id) => !slot.rows.has(id));
    if (missing.length > 0) {
      // Join the open wave (its fetch departs without late arrivals); the
      // window is short enough that a lone single-address caller — the only
      // caller when no batch is in flight — pays WAVE_MS, nothing more.
      this.waveIds ??= new Set();
      for (const id of missing) this.waveIds.add(id);
      if (this.waveTimer === undefined) {
        this.waveDone = new Promise((done) => {
          this.waveTimer = setTimeout(() => {
            const ids = [...(this.waveIds ?? new Set<string>())];
            this.waveIds = undefined;
            this.waveTimer = undefined;
            void this.fetchInto(collectionName, ids, readTreeGraph, true)
              .catch(() => undefined)
              .finally(done);
          }, WAVE_MS);
        });
      }
      await this.waveDone;
    }
    return wanted.flatMap((id) => slot.rows.get(id) ?? []);
  }

  private slotFor(collectionName: string, readTreeGraph?: WorkingTreeGraphReader): CacheSlot<Row> {
    const key = `${collectionName}\u0000${readTreeGraph ? "tree" : "index"}`;
    if (this.slot?.key !== key) this.slot = { key, rows: new Map() };
    return this.slot;
  }

  private async fetchInto(
    collectionName: string,
    symbolIds: readonly string[],
    readTreeGraph: WorkingTreeGraphReader | undefined,
    reserveOnError: boolean,
  ): Promise<void> {
    const slot = this.slotFor(collectionName, readTreeGraph);
    let rows: Row[];
    try {
      rows = await this.fetch(collectionName, symbolIds, readTreeGraph);
    } catch (error) {
      if (reserveOnError) {
        // Reserve the ids so a failing fetch does not retry per address in a
        // tight loop; the empty rows read as "no decoration" downstream.
        for (const id of symbolIds) if (!slot.rows.has(id)) slot.rows.set(id, []);
      }
      throw error;
    }
    for (const row of rows) {
      for (const id of this.rowIds(row)) {
        const held = slot.rows.get(id);
        if (held) held.push(row);
        else slot.rows.set(id, [row]);
      }
    }
    for (const id of symbolIds) if (!slot.rows.has(id)) slot.rows.set(id, []);
  }
}

/** The wrappers a find_symbol batch hands its per-address strategies. */
export interface BatchedResolvers {
  readonly ancestors: ContainerAncestorResolver | undefined;
  readonly visibility: SymbolVisibilityResolver | undefined;
  /** Warm both caches with one resolver call each; see the module doc. */
  prefetch: (
    collectionName: string,
    symbolIds: readonly string[],
    readTreeGraph?: WorkingTreeGraphReader,
  ) => Promise<void>;
}

/** Wrap the (optional) decoration resolvers for one batch. */
export function batchedResolvers(
  ancestors: ContainerAncestorResolver | undefined,
  visibility: SymbolVisibilityResolver | undefined,
): BatchedResolvers {
  // The builders capture the NON-optional resolver, so the fetch closures need
  // no non-null assertion at the call site.
  const ancestorRows = ancestors
    ? new BatchedLookup<InheritanceEdge>(
        async (collectionName, ids, tree) =>
          tree
            ? ancestors.resolveContainerAncestors(collectionName, ids, tree)
            : ancestors.resolveContainerAncestors(collectionName, ids),
        (edge) => [edge.sourceFqName],
      )
    : undefined;
  const visibilityRows = visibility
    ? new BatchedLookup<SymbolVisibilityRow>(
        async (collectionName, ids, tree) =>
          tree
            ? visibility.resolveSymbolVisibilities(collectionName, ids, tree)
            : visibility.resolveSymbolVisibilities(collectionName, ids),
        (row) => [row.symbolId],
      )
    : undefined;
  return {
    ancestors:
      ancestorRows === undefined
        ? undefined
        : {
            resolveContainerAncestors: async (collectionName, ids, tree) =>
              ancestorRows.resolve(collectionName, ids, tree),
          },
    visibility:
      visibilityRows === undefined
        ? undefined
        : {
            resolveSymbolVisibilities: async (collectionName, ids, tree) =>
              visibilityRows.resolve(collectionName, ids, tree),
          },
    prefetch: async (collectionName, ids, tree) => {
      await Promise.all([
        ancestorRows?.prefetch(collectionName, ids, tree) ?? Promise.resolve(),
        visibilityRows?.prefetch(collectionName, ids, tree) ?? Promise.resolve(),
      ]);
    },
  };
}

/**
 * Every id prefetch can name from the batch's addresses alone: the address
 * without its `#member` tail (a member's container; a scope is its own
 * container) and, for namespaced ids, the container's parent namespace (the
 * outline's next ancestor hop). Over-naming is free — one resolver call.
 */
export function containerIdsOf(addresses: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const address of addresses) {
    const base = address.split("#")[0];
    if (base.length === 0) continue;
    ids.add(base);
    const cut = base.lastIndexOf("::");
    if (cut > 0) ids.add(base.slice(0, cut));
  }
  return [...ids];
}
