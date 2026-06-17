/** Percentile keys resolvable from collection Stats. */
export type FilterPercentile = "p10" | "p25" | "p50" | "p75" | "p90" | "p95";

/** A range threshold: a literal number, or an adaptive collection percentile with a mandatory cold-start fallback. */
export type FilterThreshold = number | { percentile: FilterPercentile; fallback: number };

/** One raw-signal condition. `signal` is the LOGICAL payload key (e.g. "git.chunk.commitCount", "codegraph.file.instability", "isTest"). */
export interface AdaptiveFilterCondition {
  signal: string;
  op: "gte" | "lte" | "eq";
  /** number/FilterThreshold for range ops (gte/lte); string/boolean for eq match. */
  value: FilterThreshold | string | boolean;
  /** default "must". "should" compiles to a nested must:[{should:[...]}] group (at-least-one-required). */
  occur?: "must" | "should" | "must_not";
}

/** A named, gateable bundle of filter conditions. NOT a RerankPreset (no weights/tools/overlayMask). */
export interface FilterPresetDef {
  readonly name: string;
  readonly description: string;
  /** trajectory keys that must all be registered for this preset to be available, e.g. ["codegraph.symbols"]. */
  readonly requires?: readonly string[];
  readonly conditions: readonly AdaptiveFilterCondition[];
}

/** Value of the user-facing `filter` param and of RerankPreset.filter: raw Qdrant filter OR a named-presets reference. */
export type FilterSpec = Record<string, unknown> | { presets: string };
