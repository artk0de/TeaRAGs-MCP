/**
 * ArchitectureReportOps — the query behind `get_architecture_report`
 * (bd tea-rags-mcp-94hd9).
 *
 * Reads the whole file dependency graph from a codegraph handle, runs the
 * boundary detectors owned by the codegraph trajectory, and shapes the typed
 * report DTO. Lives in `api/internal` because it bridges the trajectory's
 * detector and the public DTO — the one layer allowed to import both.
 *
 * Collection resolution and the READ handle are the caller's
 * (`GraphFacade#getArchitectureReport` routes through the same daemon-proxied
 * reader `find_cycles` uses), so this class never opens a DuckDB file.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";
import {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectStableDependencyViolations,
  NO_SYMBOL_ENDPOINT_REASON,
  PRIVATE_COLLABORATOR_REASON,
  type StableDependenciesReport,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  ArchitectureRootCause,
  ArchitectureViolation,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
  StableDependenciesReportSummary,
} from "../../public/dto/architecture.js";

/** Default `GetArchitectureReportRequest.limit`. */
export const DEFAULT_ARCHITECTURE_REPORT_LIMIT = 50;

type ArchitectureReportScope = Pick<GetArchitectureReportRequest, "pathPattern" | "limit">;

export class ArchitectureReportOps {
  /** Judge the graph behind `graphDb` and shape the report. */
  async build(
    graphDb: Pick<GraphDbClient, "readFileDependencyGraph">,
    request: ArchitectureReportScope,
  ): Promise<GetArchitectureReportResponse> {
    const graph = await graphDb.readFileDependencyGraph();
    const report = detectStableDependencyViolations(graph, { sourcePathPattern: request.pathPattern });
    const limit = request.limit ?? DEFAULT_ARCHITECTURE_REPORT_LIMIT;
    return {
      ...(request.pathPattern ? { pathPattern: request.pathPattern } : {}),
      summary: { stableDependencies: summarise(report) },
      rootCauses: report.rootCauses.slice(0, limit).map(
        (r): ArchitectureRootCause => ({
          detector: "stableDependencies",
          targetRelPath: r.targetRelPath,
          targetInstability: r.targetInstability,
          violationCount: r.violationCount,
          maxInstabilityDelta: r.maxInstabilityDelta,
          sources: r.sources,
          cycleWithDependents: r.cycleWithDependents,
        }),
      ),
      violations: report.violations.slice(0, limit).map(
        (v): ArchitectureViolation => ({
          detector: "stableDependencies",
          sourceRelPath: v.sourceRelPath,
          targetRelPath: v.targetRelPath,
          evidence: {
            sourceInstability: v.sourceInstability,
            targetInstability: v.targetInstability,
            instabilityDelta: v.instabilityDelta,
            sourceConnectionCount: v.sourceConnectionCount,
            targetConnectionCount: v.targetConnectionCount,
            callWeight: v.callWeight,
            directoryRelation: v.directoryRelation,
          },
        }),
      ),
    };
  }

  /**
   * The report for a collection that has no codegraph database: nothing read.
   * `edgeCount: 0` is what tells it apart from a judged, clean graph.
   */
  static empty(request: ArchitectureReportScope): GetArchitectureReportResponse {
    return {
      ...(request.pathPattern ? { pathPattern: request.pathPattern } : {}),
      summary: {
        stableDependencies: {
          tolerance: DEFAULT_SDP_TOLERANCE,
          minConnectionCount: DEFAULT_SDP_MIN_CONNECTION_COUNT,
          edgeCount: 0,
          judgedEdgeCount: 0,
          violationCount: 0,
          rootCauseCount: 0,
          excluded: {
            selfEdges: 0,
            unwalkedEndpoints: 0,
            noSymbolEndpoints: 0,
            lowConnectionCount: 0,
            privateCollaborators: 0,
          },
          exclusionReasons: EXCLUSION_REASONS,
        },
      },
      rootCauses: [],
      violations: [],
    };
  }
}

const EXCLUSION_REASONS = {
  noSymbolEndpoints: NO_SYMBOL_ENDPOINT_REASON,
  privateCollaborators: PRIVATE_COLLABORATOR_REASON,
} as const;

function summarise(report: StableDependenciesReport): StableDependenciesReportSummary {
  const { summary } = report;
  return {
    tolerance: summary.tolerance,
    minConnectionCount: summary.minConnectionCount,
    edgeCount: summary.edgeCount,
    judgedEdgeCount: summary.consideredEdgeCount,
    violationCount: summary.violationCount,
    rootCauseCount: report.rootCauses.length,
    excluded: { ...summary.excluded },
    exclusionReasons: EXCLUSION_REASONS,
    ...(summary.scope ? { outOfScopeEdgeCount: summary.scope.outOfScopeEdgeCount } : {}),
  };
}
