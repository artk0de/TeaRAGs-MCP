/**
 * RankModule — scroll-based chunk ranking without vector search.
 *
 * Scatter-gather: resolve order_by fields from preset weights → parallel scroll → merge → rerank.
 */

import type { DerivedSignalDescriptor, RerankableResult } from "../contracts/types/reranker.js";
import type { Reranker } from "./reranker.js";

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

export interface RankOptions {
  weights: Record<string, number>;
  level: "chunk" | "file";
  limit: number;
  scrollFn: ScrollFn;
  filter?: Record<string, unknown>;
}

const OVERFETCH_FACTOR = 3;

export class RankModule {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;

  constructor(
    private readonly reranker: Reranker,
    private readonly descriptors: DerivedSignalDescriptor[],
  ) {
    this.descriptorMap = new Map();
    for (const d of descriptors) {
      this.descriptorMap.set(d.name, d);
    }
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
    const { weights, level, limit, scrollFn, filter } = options;

    // Remove similarity and re-normalize
    const cleanWeights = this.removeAndNormalize(weights);

    // Resolve order_by fields
    const orderByFields = this.resolveOrderByFields(cleanWeights, level);
    if (orderByFields.length === 0) return [];

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
      score: 0,
      payload: p.payload,
    }));

    // Rerank with cleaned weights
    const reranked = this.reranker.rerank(rerankable, { custom: cleanWeights }, "rank_chunks");

    return reranked.slice(0, limit);
  }

  // -- Private --

  private resolvePayloadField(sources: string[], level: "chunk" | "file"): string | undefined {
    // 1. Try level-prefixed source (e.g. "chunk.commitCount" → "git.chunk.commitCount")
    const levelSource = sources.find((s) => s.startsWith(`${level}.`));
    if (levelSource) return `git.${levelSource}`;

    // 2. Try unprefixed source (e.g. "methodLines")
    const unprefixed = sources.find((s) => !s.includes("."));
    if (unprefixed) return unprefixed;

    // 3. Fallback: first source with git prefix
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
