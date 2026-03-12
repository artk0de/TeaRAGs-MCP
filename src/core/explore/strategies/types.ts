/**
 * Search strategy types — shared interface for all search execution strategies.
 *
 * Strategies encapsulate the business logic of how a search is executed
 * (vector, hybrid, scroll-rank) while keeping the MCP layer thin.
 */

export interface SearchContext {
  collectionName: string;
  query?: string;
  embedding?: number[];
  sparseVector?: { indices: number[]; values: number[] };
  limit: number;
  filter?: Record<string, unknown>;
  weights?: Record<string, number>;
  level?: "chunk" | "file";
  presetName?: string;
  offset?: number;
  pathPattern?: string;
  rerank?: unknown; // RerankMode<string> — unknown to avoid circular deps
  metaOnly?: boolean;
}

export interface RawResult {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

export interface SearchStrategy {
  readonly type: "vector" | "hybrid" | "scroll-rank";
  execute: (ctx: SearchContext) => Promise<RawResult[]>;
}

/**
 * Error thrown when hybrid search is attempted on a collection
 * that does not have hybrid search enabled.
 */
export class HybridNotEnabledError extends Error {
  constructor(collectionName: string) {
    super(
      `Collection "${collectionName}" does not have hybrid search enabled. Create a new collection with enableHybrid set to true.`,
    );
    this.name = "HybridNotEnabledError";
  }
}
