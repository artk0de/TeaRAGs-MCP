/**
 * ArchitectureReportOps — the query behind `get_architecture_report`
 * (bd tea-rags-mcp-94hd9).
 *
 * Reads the whole file dependency graph from a codegraph handle, runs the
 * boundary detectors owned by the codegraph trajectory — Stable Dependencies
 * and leaking abstraction (bd tea-rags-mcp-jetrd) — and shapes the typed
 * report DTO. Lives in `api/internal` because it bridges the trajectory's
 * detectors and the public DTO — the one layer allowed to import both.
 *
 * Collection resolution and the READ handle are the caller's
 * (`GraphFacade#getArchitectureReport` routes through the same daemon-proxied
 * reader `find_cycles` uses), so this class never opens a DuckDB file.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";
import {
  buildComponentGraph,
  COMPONENT_CONTAINMENT_REASON,
  CONVENTION_PRIVACY_LANGUAGES,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectComponentStableDependencyViolations,
  detectConventionPrivacyLeaks,
  detectLeakingAbstractions,
  excludeNonProductionFiles,
  FACADE_AGGREGATION_REASON,
  FACADE_MODULE_EXCLUSION_REASONS,
  NON_PRODUCTION_REASON,
  type ComponentStableDependenciesReport,
  type ConventionPrivacyReport,
  type FacadeModuleAssessment,
  type LeakingAbstractionReport,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import { buildNonProductionPathFilter } from "../../../infra/file-classification/index.js";
import type {
  ArchitectureRootCause,
  ArchitectureViolation,
  FacadeModuleSummary,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
  LeakingAbstractionReportSummary,
  StableDependenciesReportSummary,
} from "../../public/dto/architecture.js";

/** Default `GetArchitectureReportRequest.limit`. */
export const DEFAULT_ARCHITECTURE_REPORT_LIMIT = 50;

type ArchitectureReportScope = Pick<GetArchitectureReportRequest, "pathPattern" | "limit">;

export class ArchitectureReportOps {
  /**
   * Judge the graph behind `graphDb` and shape the report. Violations and root
   * causes are listed per detector — Stable Dependencies first — each capped
   * at `limit`; the summaries keep the totals.
   */
  async build(
    graphDb: Pick<GraphDbClient, "readFileDependencyGraph" | "readNonPublicMemberEdges">,
    request: ArchitectureReportScope,
  ): Promise<GetArchitectureReportResponse> {
    // Every detector judges the production graph (bd tea-rags-mcp-r8hme.9).
    const nonProduction = buildNonProductionPathFilter();
    const production = excludeNonProductionFiles(await graphDb.readFileDependencyGraph(), nonProduction);
    const { graph } = production;
    const leaks = detectLeakingAbstractions(graph, { sourcePathPattern: request.pathPattern });
    // Components: the modules A4 measured, plain directories elsewhere (bd tea-rags-mcp-r8hme.7).
    const components = buildComponentGraph(graph, leaks.modules);
    const sdp = detectComponentStableDependencyViolations(components, { sourcePathPattern: request.pathPattern });
    const memberEdges = await graphDb.readNonPublicMemberEdges([...CONVENTION_PRIVACY_LANGUAGES]);
    const privacy = detectConventionPrivacyLeaks(
      memberEdges.filter((e) => !nonProduction.ignores(e.sourceRelPath) && !nonProduction.ignores(e.targetRelPath)),
      { sourcePathPattern: request.pathPattern },
    );
    const limit = request.limit ?? DEFAULT_ARCHITECTURE_REPORT_LIMIT;
    return {
      ...(request.pathPattern ? { pathPattern: request.pathPattern } : {}),
      summary: {
        nonProduction: {
          excludedFileCount: production.excludedFileCount,
          excludedEdgeCount: production.excludedEdgeCount,
          reason: NON_PRODUCTION_REASON,
        },
        stableDependencies: summarise(sdp),
        leakingAbstraction: summariseLeaks(leaks, privacy, limit),
      },
      rootCauses: [...sdpRootCauses(sdp, limit), ...leakRootCauses(leaks, limit)],
      violations: [...sdpViolations(sdp, limit), ...leakViolations(leaks, privacy, limit)],
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
        nonProduction: { excludedFileCount: 0, excludedEdgeCount: 0, reason: NON_PRODUCTION_REASON },
        stableDependencies: {
          tolerance: DEFAULT_SDP_TOLERANCE,
          minConnectionCount: DEFAULT_SDP_MIN_CONNECTION_COUNT,
          edgeCount: 0,
          componentCount: 0,
          moduleComponentCount: 0,
          directoryComponentCount: 0,
          componentEdgeCount: 0,
          judgedEdgeCount: 0,
          violationCount: 0,
          rootCauseCount: 0,
          excluded: {
            selfEdges: 0,
            unwalkedEndpoints: 0,
            intraComponent: 0,
            facadeAggregations: 0,
            containment: 0,
            lowConnectionCount: 0,
          },
          exclusionReasons: EXCLUSION_REASONS,
        },
        leakingAbstraction: summariseLeaks(
          detectLeakingAbstractions({ files: [], edges: [] }),
          detectConventionPrivacyLeaks([]),
          0,
        ),
      },
      rootCauses: [],
      violations: [],
    };
  }
}

const EXCLUSION_REASONS = {
  facadeAggregations: FACADE_AGGREGATION_REASON,
  containment: COMPONENT_CONTAINMENT_REASON,
} as const;

function summarise(report: ComponentStableDependenciesReport): StableDependenciesReportSummary {
  const { summary } = report;
  return {
    tolerance: summary.tolerance,
    minConnectionCount: summary.minConnectionCount,
    edgeCount: summary.edgeCount,
    componentCount: summary.componentCount,
    moduleComponentCount: summary.moduleComponentCount,
    directoryComponentCount: summary.directoryComponentCount,
    componentEdgeCount: summary.componentEdgeCount,
    judgedEdgeCount: summary.judgedEdgeCount,
    violationCount: summary.violationCount,
    rootCauseCount: report.rootCauses.length,
    excluded: { ...summary.excluded },
    exclusionReasons: EXCLUSION_REASONS,
    ...(summary.scope ? { outOfScopeEdgeCount: summary.scope.outOfScopeEdgeCount } : {}),
  };
}

function sdpRootCauses(report: ComponentStableDependenciesReport, limit: number): ArchitectureRootCause[] {
  return report.rootCauses.slice(0, limit).map(
    (r): ArchitectureRootCause => ({
      detector: "stableDependencies",
      targetComponent: r.targetComponent,
      targetInstability: r.targetInstability,
      violationCount: r.violationCount,
      maxInstabilityDelta: r.maxInstabilityDelta,
      sources: r.sources,
      cycleWithDependents: r.cycleWithDependents,
    }),
  );
}

function sdpViolations(report: ComponentStableDependenciesReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map(
    (v): ArchitectureViolation => ({
      detector: "stableDependencies",
      sourceComponent: v.sourceComponent,
      targetComponent: v.targetComponent,
      evidence: {
        sourceInstability: v.sourceInstability,
        targetInstability: v.targetInstability,
        instabilityDelta: v.instabilityDelta,
        sourceAfferentCount: v.sourceAfferentCount,
        sourceEfferentCount: v.sourceEfferentCount,
        targetAfferentCount: v.targetAfferentCount,
        targetEfferentCount: v.targetEfferentCount,
        callWeight: v.callWeight,
        directoryRelation: v.directoryRelation,
        fileEdgeCount: v.fileEdgeCount,
        fileEdges: v.fileEdges,
      },
    }),
  );
}

function summariseLeaks(
  report: LeakingAbstractionReport,
  privacy: ConventionPrivacyReport,
  limit: number,
): LeakingAbstractionReportSummary {
  const { summary } = report;
  const notAdopted = report.modules
    .filter((m) => m.status === "facade-not-adopted")
    .sort((a, b) => b.externalImporterCount - a.externalImporterCount || compareCodePoints(a.moduleDir, b.moduleDir));
  return {
    adoptionThreshold: summary.adoptionThreshold,
    adoptionThresholdMethod: summary.adoptionThresholdMethod,
    ...(summary.adoptionSeparability === undefined
      ? {}
      : { adoptionSeparability: Math.round(summary.adoptionSeparability * 1000) / 1000 }),
    minExternalImporters: summary.minExternalImporters,
    edgeCount: summary.edgeCount,
    judgedEdgeCount: summary.judgedEdgeCount,
    violationCount: summary.violationCount + privacy.summary.violationCount,
    rootCauseCount: report.rootCauses.length,
    violationsByKind: { ...summary.violationsByKind, conventionPrivacy: privacy.summary.violationCount },
    conventionPrivacy: {
      candidateEdgeCount: privacy.summary.candidateEdgeCount,
      violationsByRule: { ...privacy.summary.violationsByRule },
    },
    moduleCount: summary.moduleCount,
    activeModuleCount: summary.activeModuleCount,
    excludedModules: { ...summary.excludedModules },
    exclusionReasons: { ...FACADE_MODULE_EXCLUSION_REASONS },
    activeModules: report.modules
      .filter((m) => m.status === "active")
      .slice(0, limit)
      .map(moduleSummary),
    notAdoptedModules: notAdopted.slice(0, limit).map(moduleSummary),
    ...(summary.scope ? { outOfScopeEdgeCount: summary.scope.outOfScopeEdgeCount } : {}),
  };
}

function moduleSummary(m: FacadeModuleAssessment): FacadeModuleSummary {
  return {
    moduleDir: m.moduleDir,
    facadeRelPath: m.facadeRelPath,
    externalImporterCount: m.externalImporterCount,
    facadeImporterCount: m.facadeImporterCount,
    deepImporterCount: m.deepImporterCount,
    adoption: m.adoption,
  };
}

function leakRootCauses(report: LeakingAbstractionReport, limit: number): ArchitectureRootCause[] {
  return report.rootCauses.slice(0, limit).map(
    (r): ArchitectureRootCause => ({
      detector: "leakingAbstraction",
      moduleDir: r.moduleDir,
      facadeRelPath: r.facadeRelPath,
      adoption: r.adoption,
      facadeImporterCount: r.facadeImporterCount,
      deepImporterCount: r.deepImporterCount,
      violationCount: r.violationCount,
      bypassCount: r.bypassCount,
      internalReachCount: r.internalReachCount,
      sources: r.sources,
    }),
  );
}

function leakViolations(
  report: LeakingAbstractionReport,
  privacy: ConventionPrivacyReport,
  limit: number,
): ArchitectureViolation[] {
  const facadeLeaks = report.violations.map(
    (v): ArchitectureViolation => ({
      detector: "leakingAbstraction",
      kind: v.kind,
      sourceRelPath: v.sourceRelPath,
      targetRelPath: v.targetRelPath,
      evidence: {
        moduleDir: v.moduleDir,
        facadeRelPath: v.facadeRelPath,
        adoption: v.adoption,
        facadeImporterCount: v.facadeImporterCount,
        deepImporterCount: v.deepImporterCount,
        callWeight: v.callWeight,
        ...(v.importedNames ? { importedNames: v.importedNames } : {}),
        ...(v.nonExportedNames ? { nonExportedNames: v.nonExportedNames } : {}),
      },
    }),
  );
  const privacyLeaks = privacy.violations.map(
    (v): ArchitectureViolation => ({
      detector: "leakingAbstraction",
      kind: "conventionPrivacy",
      sourceRelPath: v.sourceRelPath,
      targetRelPath: v.targetRelPath,
      evidence: { sourceSymbolId: v.sourceSymbolId, targetSymbolId: v.targetSymbolId, rule: v.rule },
    }),
  );
  // One detector, one cap: facade leaks first, then convention-privacy leaks.
  return [...facadeLeaks, ...privacyLeaks].slice(0, limit);
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
