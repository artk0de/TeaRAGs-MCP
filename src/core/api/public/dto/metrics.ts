import type { Distributions } from "../../../contracts/types/trajectory.js";
import type { EnrichmentHealthMap } from "../../../domains/ingest/pipeline/enrichment/types.js";

/** Signal statistics with label-to-threshold mapping for a single signal. */
export interface SignalMetrics {
  min: number;
  max: number;
  mean?: number;
  count: number;
  /** Label name → threshold value. E.g. { "high": 12, "extreme": 30 } */
  labelMap: Record<string, number>;
  /**
   * Render hint copied from the signal descriptor's `stats.format`. A consumer
   * (e.g. prime) displays labelMap values as percentages: `"percent"` scales a
   * [0,1] fraction ×100; `"percent100"` appends `%` to an already-0–100 value
   * without scaling. Values in labelMap stay raw; this only affects display.
   */
  format?: "percent" | "percent100";
}

/** Collection-level metrics returned by get_index_metrics MCP tool. */
export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  /** Signal stats grouped by language → signal → scope → metrics. Scopes: "source", "test". */
  signals: Record<string, Record<string, Record<string, SignalMetrics>>>;
  /** Per-provider enrichment health (e.g. { git: { file: ..., chunk: ... } }) */
  enrichment?: EnrichmentHealthMap;
}
