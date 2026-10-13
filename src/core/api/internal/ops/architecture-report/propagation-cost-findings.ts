import type { computePropagationCost } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { PropagationCostReportSummary } from "../../../public/dto/architecture.js";

/** The whole aggregate, with the component breakdown — already ordered by reach — capped at `limit`. */
export function summarisePropagationCost(
  report: ReturnType<typeof computePropagationCost>,
  limit: number,
): PropagationCostReportSummary {
  // The per-file reach and its cut predicate feed the impact tiers (bd
  // tea-rags-mcp-r8hme.53); the summary stays the aggregate.
  const { components, fileVisibilityFanIn: _fanIn, admitsVisibilityFanIn: _admits, ...aggregate } = report;
  return { ...aggregate, componentCount: components.length, components: components.slice(0, limit) };
}
