// The metrics shapes live in contracts so the explore domain that builds them
// need not import the api layer (bd tea-rags-mcp-g7w8f).
export type { IndexMetrics, SignalMetrics } from "../../../contracts/types/index-metrics.js";

/** How a metrics read is answered — beyond which index it describes. */
export interface IndexMetricsReadOptions {
  /**
   * Attach the `workingTree` marker (default `true`). Measuring it diffs the
   * caller's tree against the index; a reader that renders no marker — the
   * project digest — declines it (bd tea-rags-mcp-o4p5l).
   */
  workingTreeMarker?: boolean;
}
