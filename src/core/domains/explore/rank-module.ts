/**
 * RankModule — scroll-based chunk ranking without vector search.
 *
 * Scatter-gather: resolve order_by fields from preset weights → parallel scroll → merge → rerank.
 */

import { toPhysicalPayloadKey } from "../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor, RerankableResult } from "../../contracts/types/reranker.js";
import type { PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { buildSignalKeyMap, type Reranker } from "./reranker.js";

interface OrderByField {
  key: string;
  direction: "asc" | "desc";
}

type ScrollFn = (
  collectionName: string,
  orderBy: OrderByField,
  limit: number,
  filter?: Record<string, unknown>,
) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;

type EnsureIndexFn = (collectionName: string, fieldName: string) => Promise<void>;

export interface RankOptions {
  weights: Record<string, number>;
  level: "chunk" | "file";
  limit: number;
  scrollFn: ScrollFn;
  ensureIndexFn?: EnsureIndexFn;
  filter?: Record<string, unknown>;
  /** Original preset name — passed to reranker for overlay mask resolution. */
  presetName?: string;
  /**
   * Payload field the preset collapses results on after rerank (its
   * `groupBy`). The pool is then sized in distinct groups, not points.
   */
  groupBy?: string;
  /**
   * Rewrites the gathered candidate pool before the rerank — the working
   * tree's substitution (bd tea-rags-mcp-xi2r9, WTO-5): base rows of touched
   * files out, the tree's rows of them in. Absent → the pool as scrolled.
   *
   * `legFilters` are the filters the scroll legs actually applied, one per leg —
   * the request filter, plus the age-stamp floor on a stamp leg. A row pooled
   * from elsewhere joins only when one of them admits it, as its indexed twin
   * reached the pool only through a leg that admitted it (live G3).
   */
  substituteCandidates?: (
    candidates: { id: string | number; payload: Record<string, unknown> }[],
    legFilters: readonly (Record<string, unknown> | undefined)[],
  ) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
}

const OVERFETCH_FACTOR = 3;
/**
 * How many times one scroll may double its window while hunting for distinct
 * groups — up to 2^4 = 16x the initial `limit * OVERFETCH_FACTOR` points.
 */
const MAX_GROUP_FILL_DOUBLINGS = 4;

/**
 * Which STORED payload path a derived signal orders a scroll by — the half of
 * rank_chunks that needs no reranker, so the composition root can ask it for
 * every field rank_chunks may ever order by (the payload indexes a collection
 * must carry, bd tea-rags-mcp-mimq0) with the exact rule a query uses.
 */
export class OrderByFieldResolver {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;
  /** Source name (`chunk.pageRank`, `methodLines`) → declared LOGICAL payload key. */
  private readonly payloadKeyMap: Map<string, string>;
  private readonly payloadSignalTypes: Map<string, PayloadSignalDescriptor["type"]>;

  constructor(
    descriptors: DerivedSignalDescriptor[],
    /**
     * The payload signal descriptors the reranker reads — the only record of which
     * trajectory stores a source and where. A source none of them declares
     * orders nothing.
     */
    payloadSignals: PayloadSignalDescriptor[],
  ) {
    this.descriptorMap = new Map();
    for (const d of descriptors) {
      this.descriptorMap.set(d.name, d);
    }
    this.payloadKeyMap = buildSignalKeyMap(payloadSignals);
    this.payloadSignalTypes = new Map(payloadSignals.map((ps) => [ps.key, ps.type]));
  }

  /** Every physical payload path any one derived signal orders by, at either level. */
  allOrderByPaths(): string[] {
    const paths = new Set<string>();
    for (const name of this.descriptorMap.keys()) {
      for (const level of ["chunk", "file"] as const) {
        for (const { key } of this.resolve({ [name]: 1 }, level)) paths.add(key);
      }
    }
    return [...paths].sort();
  }

  /**
   * Resolve order_by fields from preset weights + descriptor sources + inverted flag.
   */
  resolve(weights: Record<string, number>, level: "chunk" | "file"): OrderByField[] {
    return this.resolveScrolls(weights, level).map(({ orderBy }) => orderBy);
  }

  /**
   * One ordered scroll per weighted derived signal that orders anything — its
   * order_by field, and whether the field is an age stamp whose no-commit
   * sentinel the scroll must skip.
   *
   * Direction is the descriptor's `inverted` flag read against the value the
   * descriptor normalizes. For an age-derived descriptor (`ageDerivation`) that
   * value is age = now − stamp, which FALLS as its stored `lastModifiedAt` source
   * rises, so the direction flips: `recency` (inverted over age) scrolls the
   * newest stamps first, `age` the oldest. Without the flip `recency` pooled the
   * oldest chunks in the collection.
   */
  resolveScrolls(weights: Record<string, number>, level: "chunk" | "file"): OrderByScroll[] {
    const scrolls: OrderByScroll[] = [];

    for (const [key, weight] of Object.entries(weights)) {
      if (key === "similarity" || !weight) continue;

      const desc = this.descriptorMap.get(key);
      if (!desc) continue;

      const source = this.resolveOrderSource(desc.sources, level);
      if (!source) continue;

      const ageStamp = isAgeStampSource(desc, source.logicalKey);
      const ascending = desc.inverted === true ? !ageStamp : ageStamp;
      scrolls.push({
        orderBy: { key: toPhysicalPayloadKey(source.logicalKey), direction: ascending ? "asc" : "desc" },
        ageStamp,
      });
    }

    return scrolls;
  }

  /**
   * The declared payload source a scroll orders by for one derived signal.
   *
   * Candidate order: the source at the requested level, then a dotless source, then
   * the first source. A candidate a payload descriptor declares resolves to that
   * descriptor's logical key, later mapped to its physical path
   * (`codegraph.chunk.pageRank` → `codegraph.symbols.chunk.pageRank`). Only a
   * numeric scalar orders — a `number`, or a `timestamp` (unix seconds) — since
   * Qdrant `order_by` needs a range index; a boolean (`isHub`) orders nothing and
   * still scores the pooled candidates in the rerank.
   *
   * A candidate no descriptor declares orders nothing either, exactly like an
   * unknown weight key. There is no naming convention to fall back on: a `git.`
   * guess is how codegraph signals once ordered by `git.file.fanIn`, a key no
   * point carries, and rank_chunks indexed every such guess before scrolling (bd
   * tea-rags-mcp-q34ic).
   */
  private resolveOrderSource(sources: string[], level: "chunk" | "file"): { logicalKey: string } | undefined {
    const levelSource = sources.find((s) => s.startsWith(`${level}.`));
    const unprefixed = sources.find((s) => !s.includes("."));

    for (const source of [levelSource, unprefixed, sources[0]]) {
      const logicalKey = source === undefined ? undefined : this.payloadKeyMap.get(source);
      if (logicalKey === undefined) continue;
      const type = this.payloadSignalTypes.get(logicalKey);
      return type === "number" || type === "timestamp" ? { logicalKey } : undefined;
    }

    return undefined;
  }
}

/** One ordered scroll {@link OrderByFieldResolver#resolveScrolls} plans. */
export interface OrderByScroll {
  orderBy: OrderByField;
  /**
   * The field is the last-commit stamp an age-derived descriptor reads. A
   * stamp ≤ 0 (the chunk no-commit sentinel) carries no age, so the scroll
   * admits only stamps above it — otherwise the oldest-first `age` scroll
   * would pool every never-committed chunk ahead of the oldest real one.
   */
  ageStamp: boolean;
}

/** Whether `logicalKey` is the timestamp an age-derived descriptor derives its age from. */
function isAgeStampSource(desc: DerivedSignalDescriptor, logicalKey: string): boolean {
  const field = desc.ageDerivation?.timestampField;
  return field !== undefined && logicalKey.endsWith(`.${field}`);
}

/** The scroll's filter plus `key > 0` — the age-stamp floor of {@link OrderByScroll.ageStamp}. */
function withAgeStampFloor(filter: Record<string, unknown> | undefined, key: string): Record<string, unknown> {
  const floor = { key, range: { gt: 0 } };
  if (!filter) return { must: [floor] };
  const { must } = filter;
  const existing: unknown[] = Array.isArray(must) ? must : must === undefined ? [] : [must];
  return { ...filter, must: [...existing, floor] };
}

export class RankModule {
  private readonly orderBy: OrderByFieldResolver;

  constructor(
    private readonly reranker: Reranker,
    descriptors: DerivedSignalDescriptor[],
    /** The payload signal descriptors the reranker reads — see {@link OrderByFieldResolver}. */
    payloadSignals: PayloadSignalDescriptor[],
  ) {
    this.orderBy = new OrderByFieldResolver(descriptors, payloadSignals);
  }

  /**
   * Resolve order_by fields from preset weights + descriptor sources + inverted flag.
   */
  resolveOrderByFields(weights: Record<string, number>, level: "chunk" | "file"): OrderByField[] {
    return this.orderBy.resolve(weights, level);
  }

  /**
   * Rank chunks: scatter-gather → merge → rerank → top-N.
   */
  async rankChunks(collectionName: string, options: RankOptions): Promise<RerankableResult[]> {
    const { weights, level, limit, scrollFn, ensureIndexFn, filter, presetName, groupBy, substituteCandidates } =
      options;

    // Remove similarity and re-normalize
    const cleanWeights = this.removeAndNormalize(weights);

    // Resolve order_by scrolls
    const scrolls = this.orderBy.resolveScrolls(cleanWeights, level);
    if (scrolls.length === 0) return [];

    // Ensure payload indexes exist for order_by fields (Qdrant requires range index)
    if (ensureIndexFn) {
      await Promise.all(scrolls.map(async ({ orderBy }) => ensureIndexFn(collectionName, orderBy.key)));
    }

    // Parallel scroll (scatter), each window sized in distinct groups
    const targetGroups = limit * OVERFETCH_FACTOR;
    const legFilters = scrolls.map(({ orderBy, ageStamp }) =>
      ageStamp ? withAgeStampFloor(filter, orderBy.key) : filter,
    );
    const scrollResults = await Promise.all(
      scrolls.map(async ({ orderBy }, leg) =>
        this.scrollDistinctGroups(targetGroups, groupBy, async (n) =>
          scrollFn(collectionName, orderBy, n, legFilters[leg]),
        ),
      ),
    );

    // Merge + deduplicate (gather), then the caller's substitution, held to the legs' filters
    const gathered = this.mergeAndDeduplicate(scrollResults);
    const merged = substituteCandidates ? await substituteCandidates(gathered, legFilters) : gathered;
    if (merged.length === 0) return [];

    // Convert to RerankableResult (score=0, no similarity)
    const rerankable: RerankableResult[] = merged.map((p) => ({
      id: p.id,
      score: 0,
      payload: p.payload,
    }));

    // Rerank: use cleaned weights (no similarity) with preset overlay mask
    const rerankMode = presetName ? { custom: cleanWeights, preset: presetName } : { custom: cleanWeights };
    const reranked = await this.reranker.rerank(rerankable, rerankMode, "rank_chunks", { signalLevel: level });

    return reranked.slice(0, limit);
  }

  // -- Private --

  /**
   * One ordered scroll, widened until it holds `targetGroups` distinct groups
   * or the source runs out (a window that came back short).
   *
   * Without a `groupBy` every point is its own group and the first window is
   * the whole answer. With one, the points of a single group sit side by side
   * in the order — every `#partN` of a split method shares its `methodLines` —
   * so a window of `limit * 3` points could hold a handful of groups, and the
   * group collapse after rerank left the result to whatever the other scrolls
   * brought: 3 real hits and 11 two-line methods for decomposition at limit 14,
   * and results that changed with `limit` (bd tea-rags-mcp-s9vgb).
   */
  private async scrollDistinctGroups(
    targetGroups: number,
    groupBy: string | undefined,
    scroll: (n: number) => Promise<{ id: string | number; payload: Record<string, unknown> }[]>,
  ): Promise<{ id: string | number; payload: Record<string, unknown> }[]> {
    let window = targetGroups;
    let points = await scroll(window);
    if (!groupBy) return points;
    for (let doubling = 0; doubling < MAX_GROUP_FILL_DOUBLINGS; doubling++) {
      if (points.length < window || countGroups(points, groupBy) >= targetGroups) break;
      window *= 2;
      points = await scroll(window);
    }
    return points;
  }

  private removeAndNormalize(weights: Record<string, number>): Record<string, number> {
    const clean: Record<string, number> = {};
    let total = 0;

    for (const [key, weight] of Object.entries(weights)) {
      if (key === "similarity" || !weight) continue;
      clean[key] = weight;
      total += weight;
    }

    if (total === 0) return clean;

    for (const key of Object.keys(clean)) {
      clean[key] = clean[key] / total;
    }

    return clean;
  }

  private mergeAndDeduplicate(
    scrollResults: { id: string | number; payload: Record<string, unknown> }[][],
  ): { id: string | number; payload: Record<string, unknown> }[] {
    const seen = new Map<string | number, { id: string | number; payload: Record<string, unknown> }>();

    for (const results of scrollResults) {
      for (const point of results) {
        if (!seen.has(point.id)) {
          seen.set(point.id, point);
        }
      }
    }

    return [...seen.values()];
  }
}

/** Distinct `groupBy` values in `points`; a point without one is its own group, as in `groupByTop`. */
function countGroups(points: { id: string | number; payload: Record<string, unknown> }[], groupBy: string): number {
  const keys = new Set<string>();
  for (const p of points) {
    const raw = p.payload[groupBy];
    keys.add(typeof raw === "string" && raw !== "" ? `g:${raw}` : `id:${String(p.id)}`);
  }
  return keys.size;
}
