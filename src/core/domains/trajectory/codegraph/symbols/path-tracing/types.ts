// src/core/domains/trajectory/codegraph/symbols/path-tracing/types.ts
import type { SymbolId } from "../../../../../contracts/types/codegraph.js";

/** One enumerated call path, in execution order (caller -> callee). */
export type EnumeratedPath = SymbolId[];

export interface EnumerateOptions {
  /** Max edges on a path (depth = number of hops, not number of nodes). */
  maxDepth: number;
  /** Hard cap on returned paths; enumeration stops once reached. */
  maxPaths: number;
}

export interface EnumerateResult {
  /** Simple paths A->B (no repeated node), each in execution order. */
  paths: EnumeratedPath[];
  /** True if the `maxPaths` cap stopped enumeration before exhaustion. */
  truncated: boolean;
}
