import {
  FACADE_MODULE_EXCLUSION_REASONS,
  type ConventionPrivacyReport,
  type FacadeModuleAssessment,
  type LeakingAbstractionReport,
} from "../../../../domains/trajectory/codegraph/symbols/index.js";
import type {
  ArchitectureRootCause,
  ArchitectureViolation,
  FacadeModuleSummary,
  LeakingAbstractionReportSummary,
} from "../../../public/dto/architecture.js";
import { compareCodePoints } from "./architecture-report-value-format.js";

export function summariseLeaks(
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
    deFactoSurfaces: summary.deFactoSurfaces.slice(0, limit).map((s) => ({ ...s })),
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

export function leakRootCauses(report: LeakingAbstractionReport, limit: number): ArchitectureRootCause[] {
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

export function leakViolations(
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
        kindBasis: v.kindBasis,
        reExportUnsafe: v.reExportUnsafe,
        ...(v.reExportCyclePath ? { reExportCyclePath: v.reExportCyclePath } : {}),
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
