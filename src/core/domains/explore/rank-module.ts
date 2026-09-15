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
}

const OVERFETCH_FACTOR = 3;

export class RankModule {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;
  /** Source name (`chunk.pageRank`, `methodLines`) → declared LOGICAL payload key. */
  private readonly payloadKeyMap: Map<string, string>;
  private readonly payloadSignalTypes: Map<string, PayloadSignalDescriptor["type"]>;

  constructor(
    private readonly reranker: Reranker,
    private readonly descriptors: DerivedSignalDescriptor[],
    /**
     * The payload signal descriptors the reranker reads — the only record of which
     * trajectory stores a source and where. Without them every level-qualified
     * source falls back to the `git.` convention.
     */
    payloadSignals: PayloadSignalDescriptor[] = [],
  ) {
    this.descriptorMap = new Map();
    for (const d of descriptors) {
      this.descriptorMap.set(d.name, d);
    }
    this.payloadKeyMap = buildSignalKeyMap(payloadSignals);
    this.payloadSignalTypes = new Map(payloadSignals.map((ps) => [ps.key, ps.type]));
  }

  /**
   * Resolve order_by fields from preset weights + descriptor sources + inverted flag.
   */
  resolveOrderByFields(weights: Record<string, number>, level: "chunk" | "file"): OrderByField[] {
    const fields: OrderByField[] = [];

    for (const [key, weight] of Object.entries(weights)) {
      if (key === "similarity" || !weight) continue;

      const desc = this.descriptorMap.get(key);
      if (!desc) continue;

      const payloadField = this.resolvePayloadField(desc.sources, level);
      if (!payloadField) continue;

      fields.push({
        key: payloadField,
        direction: desc.inverted ? "asc" : "desc",
      });
    }

    return fields;
  }

  /**
   * Rank chunks: scatter-gather → merge → rerank → top-N.
   */
  async rankChunks(collectionName: string, options: RankOptions): Promise<RerankableResult[]> {
    const { weights, level, limit, scrollFn, ensureIndexFn, filter, presetName } = options;

    // Remove similarity and re-normalize
    const cleanWeights = this.removeAndNormalize(weights);

    // Resolve order_by fields
    const orderByFields = this.resolveOrderByFields(cleanWeights, level);
    if (orderByFields.length === 0) return [];

    // Ensure payload indexes exist for order_by fields (Qdrant requires range index)
    if (ensureIndexFn) {
      await Promise.all(orderByFields.map(async (field) => ensureIndexFn(collectionName, field.key)));
    }

    // Parallel scroll (scatter)
    const fetchLimit = limit * OVERFETCH_FACTOR;
    const scrollResults = await Promise.all(
      orderByFields.map(async (field) => scrollFn(collectionName, field, fetchLimit, filter)),
    );

    // Merge + deduplicate (gather)
    const merged = this.mergeAndDeduplicate(scrollResults);
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
   * The STORED payload path a scroll orders by for one derived signal.
   *
   * Candidate order: the source at the requested level, then a dotless source, then
   * the first source. A candidate a payload descriptor declares resolves to that
   * descriptor's logical key mapped to its physical path (`codegraph.chunk.pageRank`
   * → `codegraph.symbols.chunk.pageRank`); a non-numeric one (`isHub`) orders
   * nothing, since Qdrant `order_by` needs a numeric range index — the signal still
   * scores the pooled candidates in the rerank. Only when no descriptor declares any
   * candidate does the `git.` convention apply.
   */
  private resolvePayloadField(sources: string[], level: "chunk" | "file"): string | undefined {
    const levelSource = sources.find((s) => s.startsWith(`${level}.`));
    const unprefixed = sources.find((s) => !s.includes("."));

    for (const source of [levelSource, unprefixed, sources[0]]) {
      const logicalKey = source === undefined ? undefined : this.payloadKeyMap.get(source);
      if (logicalKey === undefined) continue;
      return this.payloadSignalTypes.get(logicalKey) === "number" ? toPhysicalPayloadKey(logicalKey) : undefined;
    }

    if (levelSource) return `git.${levelSource}`;
    if (unprefixed) return unprefixed;
    return sources[0] ? `git.${sources[0]}` : undefined;
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
