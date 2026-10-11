/**
 * Index metrics (bd tea-rags-mcp-g7w8f) — the consumer-facing frame the
 * `get_index_metrics` tool returns, built ON TOP of the collection `Stats` by
 * `IndexMetricsQuery#buildSignalMetrics` in the explore domain. It lives in
 * contracts because that producer may not import the api layer;
 * `api/public/dto/metrics.ts` re-exports it as the DTO.
 */

import type { EnrichmentHealthMap } from "./enrichment.js";
import type { Distributions } from "./trajectory.js";
import type { WorkingTreeMarker } from "./working-tree.js";

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
  /** How far the caller's tree is from this index (bd tea-rags-mcp-xi2r9); absent only when no overlay is wired. */
  workingTree?: WorkingTreeMarker;
}
