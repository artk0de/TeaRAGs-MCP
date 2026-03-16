import type { Distributions } from "../../../contracts/types/trajectory.js";

/** Signal statistics with label-to-threshold mapping for a single signal. */
export interface SignalMetrics {
  min: number;
  max: number;
  mean?: number;
  count: number;
  /** Label name → threshold value. E.g. { "high": 12, "extreme": 30 } */
  labelMap: Record<string, number>;
}

/** Collection-level metrics returned by get_index_metrics MCP tool. */
export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  signals: Record<string, SignalMetrics>;
}
