import type { computePropagationCost } from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type { PropagationCostReportSummary } from "../../../public/dto/architecture.js";

/** The whole aggregate, with the component breakdown — already ordered by reach — capped at `limit`. */
export function summarisePropagationCost(
  report: ReturnType<typeof computePropagationCost>,
  limit: number,
): PropagationCostReportSummary {
  const { components, ...aggregate } = report;
  return { ...aggregate, componentCount: components.length, components: components.slice(0, limit) };
}
