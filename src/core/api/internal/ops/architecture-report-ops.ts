/**
 * ArchitectureReportOps — the query behind `get_architecture_report`
 * (bd tea-rags-mcp-94hd9).
 *
 * Reads the whole file dependency graph from a codegraph handle, runs the
 * boundary detectors owned by the codegraph trajectory — Stable Dependencies,
 * leaking abstraction (bd tea-rags-mcp-jetrd), the main sequence (bd
 * tea-rags-mcp-r8hme.8, its zone of pain gated on git volatility by bd
 * tea-rags-mcp-r8hme.14) and, over the temporal co-change sub-graph, silent
 * coupling (bd tea-rags-mcp-b4dcz) — and shapes
 * the typed report DTO. Lives in `api/internal` because it bridges the trajectory's
 * detectors and the public DTO — the one layer allowed to import both.
 *
 * Collection resolution and the READ handle are the caller's
 * (`GraphFacade#getArchitectureReport` routes through the same daemon-proxied
 * reader `find_cycles` uses), so this class never opens a DuckDB file.
 */

import { extname } from "node:path";

import type {
  FileDependencyGraph,
  GraphDbClient,
  RelPath,
  TemporalCochangeGraph,
} from "../../../contracts/types/codegraph.js";
import { DOCUMENTATION_LANGUAGES, LANGUAGE_MAP } from "../../../domains/ingest/pipeline/chunker/config.js";
import {
  buildComponentGraph,
  buildDomainComponentGraph,
  buildLayeringModel,
  buildLayerMap,
  COMPONENT_CONTAINMENT_REASON,
  CONVENTION_PRIVACY_LANGUAGES,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectComponentStableDependencyViolations,
  detectConventionPrivacyLeaks,
  detectLayeringViolations,
  detectLeakingAbstractions,
  detectMainSequenceDeviations,
  excludeNonProductionFiles,
  FACADE_AGGREGATION_REASON,
  FACADE_MODULE_EXCLUSION_REASONS,
  lookupLayeringKnot,
  MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON,
  MAIN_SEQUENCE_UNOBSERVABLE_REASON,
  NON_PRODUCTION_REASON,
  type ComponentStableDependenciesReport,
  type ConventionPrivacyReport,
  type LayeringBackEdgeViolation as DomainLayeringBackEdgeViolation,
  type LayeringFeedbackEdge as DomainLayeringFeedbackEdge,
  type LayeringViolation as DomainLayeringViolation,
  type FacadeModuleAssessment,
  type LayeringKnotLookup,
  type LayeringReport,
  type LeakingAbstractionReport,
  type MainSequenceReport,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  detectSilentCoupling,
  linkImportedCochangePairs,
  oneWalkedViolationImporters,
  SILENT_COUPLING_EXPLAINED_REASON,
  type SilentCouplingReport,
  type SilentCouplingViolation,
} from "../../../domains/trajectory/codegraph/temporal/index.js";
import { buildNonProductionPathFilter } from "../../../infra/file-classification/index.js";
import { UnknownArchitectureComponentError } from "../../errors.js";
import type {
  ArchitectureKnotView,
  ArchitectureRootCause,
  ArchitectureViolation,
  FacadeModuleSummary,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
  LayeringBackEdgeArchitectureViolation,
  LayeringPartitionCounts,
  LayeringReportSummary,
  LeakingAbstractionReportSummary,
  MainSequenceReportSummary,
  SilentCouplingArchitectureViolation,
  SilentCouplingReportSummary,
  StableDependenciesReportSummary,
} from "../../public/dto/architecture.js";

/** Default `GetArchitectureReportRequest.limit`. */
export const DEFAULT_ARCHITECTURE_REPORT_LIMIT = 50;

/** Knot / composition-cycle members listed per finding (most depended-on first); `memberCount` keeps the total. */
export const LAYERING_KNOT_MEMBER_LIMIT = 20;

/** Feedback-arc-set edges listed per knot (heaviest first); `cutEdgeCount` keeps the total. */
export const LAYERING_FEEDBACK_EDGE_LIMIT = 10;

/** Parent↔nested pairs listed per composition cycle; `nestedPairCount` keeps the total. */
export const LAYERING_NESTED_PAIR_LIMIT = 10;

/** Points a knot finding at the `knotOf` view (bd tea-rags-mcp-r8hme.38). */
export const LAYERING_KNOT_DRILL_DOWN_HINT =
  "call get_architecture_report with knotOf to page every member and cut edge of this knot";

type ArchitectureReportScope = Pick<
  GetArchitectureReportRequest,
  "pathPattern" | "limit" | "layerMap" | "knotOf" | "offset"
>;

/**
 * The module specifiers each named file declares (`payload.imports`), keyed by
 * repo-relative path; a file with none, or unknown to the index, is absent.
 * Silent coupling reads it to see an import the codegraph has no edge for
 * (bd tea-rags-mcp-rbnkp).
 */
export type ModuleImportSpecifierLookup = (
  relPaths: readonly RelPath[],
) => Promise<ReadonlyMap<RelPath, readonly string[]>>;

/**
 * Every indexed file's `git.file.commitCount`, keyed by repo-relative path; a
 * file the git trajectory never measured is absent. The main-sequence
 * detector reads it as per-file volatility to gate the zone of pain
 * (bd tea-rags-mcp-r8hme.14).
 */
export type GitFileCommitCountLookup = () => Promise<ReadonlyMap<RelPath, number>>;

/** The per-file reading the volatility gate averages — named in the summary. */
const MAIN_SEQUENCE_VOLATILITY_SIGNAL = "git.file.commitCount";

export class ArchitectureReportOps {
  /**
   * Judge the graph behind `graphDb` and shape the report. Violations and root
   * causes are listed per detector — Stable Dependencies first — each capped
   * at `limit`; the summaries keep the totals.
   *
   * `readImportSpecifiers`, when given, lets silent coupling see an import of a
   * file the codegraph does not walk — a stylesheet, a JSON module
   * (bd tea-rags-mcp-rbnkp). It is asked only about the walked endpoints of
   * one-walked violations, so its cost is bounded by the violations, not by
   * the co-change graph.
   *
   * `readFileCommitCounts`, when given, gates the zone of pain on volatility
   * (bd tea-rags-mcp-r8hme.14). It is read only when the ungated judgement
   * puts a component in the zone of pain, since only such a component can
   * change verdict.
   */
  async build(
    graphDb: Pick<GraphDbClient, "readFileDependencyGraph" | "readNonPublicMemberEdges" | "readTemporalCochangeGraph">,
    request: ArchitectureReportScope,
    readImportSpecifiers?: ModuleImportSpecifierLookup,
    readFileCommitCounts?: GitFileCommitCountLookup,
  ): Promise<GetArchitectureReportResponse> {
    // Every detector judges the production graph (bd tea-rags-mcp-r8hme.9).
    const nonProduction = buildNonProductionPathFilter();
    const production = excludeNonProductionFiles(await graphDb.readFileDependencyGraph(), nonProduction);
    const { graph } = production;
    const leaks = detectLeakingAbstractions(graph, { sourcePathPattern: request.pathPattern });
    // Components: the modules A4 measured, plain directories elsewhere (bd tea-rags-mcp-r8hme.7).
    const components = buildComponentGraph(graph, leaks.modules);
    const sdp = detectComponentStableDependencyViolations(components, { sourcePathPattern: request.pathPattern });
    // Same components, A from the walker's type census (bd tea-rags-mcp-r8hme.8),
    // the zone of pain gated on git volatility (bd tea-rags-mcp-r8hme.14).
    const mainSequenceOptions = { sourcePathPattern: request.pathPattern };
    const ungatedMainSequence = detectMainSequenceDeviations(components, graph.files, mainSequenceOptions);
    const mainSequence =
      readFileCommitCounts && ungatedMainSequence.summary.painCount > 0
        ? detectMainSequenceDeviations(components, graph.files, {
            ...mainSequenceOptions,
            fileVolatility: await readFileCommitCounts(),
          })
        : ungatedMainSequence;
    const memberEdges = await graphDb.readNonPublicMemberEdges([...CONVENTION_PRIVACY_LANGUAGES]);
    const privacy = detectConventionPrivacyLeaks(
      memberEdges.filter((e) => !nonProduction.ignores(e.sourceRelPath) && !nonProduction.ignores(e.targetRelPath)),
      { sourcePathPattern: request.pathPattern },
    );
    const silent = await detectSilentCouplingSeeingAssetImports(
      await graphDb.readTemporalCochangeGraph(),
      graph,
      request,
      readImportSpecifiers,
    );
    // Inferred layering over the DOMAIN partition (bd tea-rags-mcp-r8hme.30):
    // every facade directory is a unit whether importers adopted it or not —
    // the adoption partition levels a language vertical one component per
    // subdirectory and measures intra-vertical depth, not inter-domain
    // layering. The adoption partition's counts ride along for comparison.
    const layeringComponents = buildDomainComponentGraph(graph, leaks.modules);
    // Built once: the knot view reads the same model the detector judges.
    const layeringModel = buildLayeringModel(layeringComponents);
    const layering = detectLayeringViolations(layeringComponents, graph.files, {
      sourcePathPattern: request.pathPattern,
      model: layeringModel,
    });
    const knotLookup =
      request.knotOf === undefined
        ? undefined
        : lookupLayeringKnot(layeringComponents, layeringModel, request.knotOf, {
            sourcePathPattern: request.pathPattern,
          });
    if (knotLookup?.kind === "unknownComponent") throw new UnknownArchitectureComponentError(knotLookup.component);
    const facadePartition = {
      componentCount: components.components.size,
      levelCount: buildLayeringModel(components).levelCount,
    };
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
        silentCoupling: summariseSilentCoupling(silent, limit),
        mainSequence: summariseMainSequence(mainSequence),
        layering: summariseLayering(layering, facadePartition),
      },
      rootCauses: [...sdpRootCauses(sdp, limit), ...leakRootCauses(leaks, limit), ...silentRootCauses(silent, limit)],
      violations: [
        ...sdpViolations(sdp, limit),
        ...leakViolations(leaks, privacy, limit),
        ...silentViolations(silent, limit),
        ...mainSequenceViolations(mainSequence, limit),
        ...layeringViolations(layering, limit),
      ],
      // The layer map VIEW only when asked (bd tea-rags-mcp-r8hme.26) — a full
      // map never bloats an unqualified report. Same DOMAIN partition the
      // layering detector judges (bd tea-rags-mcp-r8hme.30), so its
      // boundary edges carry levels consistent with the summary.
      ...(request.layerMap ? { layerMap: buildLayerMap(layeringComponents, production.graph, request.layerMap) } : {}),
      // The knot VIEW only when asked (bd tea-rags-mcp-r8hme.38), paged here.
      ...(knotLookup ? { knot: knotView(knotLookup, limit, request.offset ?? 0) } : {}),
    };
  }

  /**
   * The layer map view (bd tea-rags-mcp-r8hme.26), computed over the SAME
   * production graph and component partition the detectors judge, only when
   * the request asked for one.
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
        silentCoupling: summariseSilentCoupling(detectSilentCoupling({ meta: null, edges: [] }, []), 0),
        mainSequence: summariseMainSequence(
          detectMainSequenceDeviations(buildComponentGraph({ files: [], edges: [] }, []), []),
        ),
        layering: summariseLayering(detectLayeringViolations(buildComponentGraph({ files: [], edges: [] }, []), []), {
          componentCount: 0,
          levelCount: 0,
        }),
      },
      rootCauses: [],
      violations: [],
    };
  }
}

/**
 * Silent coupling, judged twice when a one-walked violation might be an import
 * the codegraph never records: once to find those violations, then again over
 * the graph with the imported pairs linked. Linking changes no candidate's
 * strength, so the adaptive cut is the same both times — only which strong
 * pairs count as linked moves. The production graph's edges let a specific
 * shared neighbour explain a pair (bd tea-rags-mcp-r8hme.13).
 */
async function detectSilentCouplingSeeingAssetImports(
  cochange: TemporalCochangeGraph,
  production: FileDependencyGraph,
  request: ArchitectureReportScope,
  readImportSpecifiers: ModuleImportSpecifierLookup | undefined,
): Promise<SilentCouplingReport> {
  const walkedFiles = production.files;
  const options = {
    sourcePathPattern: request.pathPattern,
    isDocumentation: isDocumentationPath,
    fileDependencyEdges: production.edges,
  };
  const first = detectSilentCoupling(cochange, walkedFiles, options);
  if (!readImportSpecifiers) return first;
  const importers = oneWalkedViolationImporters(first.violations, walkedFiles);
  if (importers.length === 0) return first;
  const linked = linkImportedCochangePairs(cochange, await readImportSpecifiers(importers));
  return detectSilentCoupling(linked, walkedFiles, options);
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

/**
 * Documentation by the same language table that sets `isDocumentation` on a
 * chunk — ingest owns it, and this layer is the one allowed to bridge ingest
 * and trajectory, so the detector receives the answer instead of the table.
 */
function isDocumentationPath(relPath: RelPath): boolean {
  const language = LANGUAGE_MAP[extname(relPath).toLowerCase()];
  return language !== undefined && DOCUMENTATION_LANGUAGES.has(language);
}

function summariseSilentCoupling(report: SilentCouplingReport, limit: number): SilentCouplingReportSummary {
  const { summary } = report;
  const explained = summary.explainedCount > 0;
  return {
    built: summary.built,
    ...(summary.build ? { build: { ...summary.build } } : {}),
    pairCount: summary.pairCount,
    candidateCount: summary.candidateCount,
    strongCount: summary.strongCount,
    strongLinkedCount: summary.strongLinkedCount,
    violationCount: summary.violationCount,
    rootCauseCount: summary.rootCauseCount,
    strengthThreshold: summary.strengthThreshold,
    strengthThresholdMethod: summary.strengthThresholdMethod,
    ...(summary.strengthSeparability === undefined
      ? {}
      : { strengthSeparability: Math.round(summary.strengthSeparability * 1000) / 1000 }),
    ...(summary.sharedNeighbourThreshold === undefined
      ? {}
      : { sharedNeighbourThreshold: roundTo3(summary.sharedNeighbourThreshold) }),
    sharedNeighbourThresholdMethod: summary.sharedNeighbourThresholdMethod,
    ...(summary.sharedNeighbourSeparability === undefined
      ? {}
      : { sharedNeighbourSeparability: roundTo3(summary.sharedNeighbourSeparability) }),
    excluded: { ...summary.excluded, explainedBySharedNeighbour: summary.explainedCount },
    ...(explained ? { exclusionReasons: { explainedBySharedNeighbour: SILENT_COUPLING_EXPLAINED_REASON } } : {}),
    ...(explained
      ? { explainedPairs: report.explained.slice(0, limit).map(toSilentCouplingArchitectureViolation) }
      : {}),
    ...(summary.scope ? { outOfScopePairCount: summary.scope.outOfScopePairCount } : {}),
  };
}

function roundTo3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function silentRootCauses(report: SilentCouplingReport, limit: number): ArchitectureRootCause[] {
  return report.rootCauses.slice(0, limit).map(
    (r): ArchitectureRootCause => ({
      detector: "silentCoupling",
      relPath: r.relPath,
      violationCount: r.violationCount,
      maxStrength: r.maxStrength,
      partners: r.partners,
    }),
  );
}

function silentViolations(report: SilentCouplingReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map(toSilentCouplingArchitectureViolation);
}

function toSilentCouplingArchitectureViolation(v: SilentCouplingViolation): SilentCouplingArchitectureViolation {
  return {
    detector: "silentCoupling",
    sourceRelPath: v.relPathA,
    targetRelPath: v.relPathB,
    evidence: {
      support: v.support,
      confidenceAB: v.confidenceAB,
      confidenceBA: v.confidenceBA,
      lift: v.lift,
      strength: v.strength,
      lastCoChangeAt: v.lastCoChangeAt,
      sampleCommits: v.sampleCommits,
      structuralVisibility: v.structuralVisibility,
      directoryRelation: v.directoryRelation,
      ...(v.explainedBy
        ? { explainedBy: { relPath: v.explainedBy.relPath, weight: roundTo3(v.explainedBy.weight) } }
        : {}),
    },
  };
}

function summariseMainSequence(report: MainSequenceReport): MainSequenceReportSummary {
  const { summary } = report;
  return {
    judgedComponentCount: summary.judgedComponentCount,
    violationCount: summary.violationCount,
    painCount: summary.painCount,
    uselessnessCount: summary.uselessnessCount,
    meanDistance: round3(summary.meanDistance),
    distanceThreshold: round3(summary.distanceThreshold),
    distanceThresholdMethod: summary.distanceThresholdMethod,
    ...(summary.distanceSeparability === undefined
      ? {}
      : { distanceSeparability: round3(summary.distanceSeparability) }),
    minConnectionCount: summary.minConnectionCount,
    minTypeCount: summary.minTypeCount,
    abstractTypeShareByLanguage: Object.fromEntries(
      Object.entries(summary.abstractTypeShareByLanguage).map(([language, share]) => [language, round3(share)]),
    ),
    excluded: { ...summary.excluded },
    exclusionReasons: {
      unobservableAbstractness: MAIN_SEQUENCE_UNOBSERVABLE_REASON,
      stableConcreteCalm: MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON,
    },
    ...(summary.volatility
      ? {
          volatility: {
            signal: MAIN_SEQUENCE_VOLATILITY_SIGNAL,
            threshold: round3(summary.volatility.threshold),
            thresholdMethod: summary.volatility.thresholdMethod,
            ...(summary.volatility.separability === undefined
              ? {}
              : { separability: round3(summary.volatility.separability) }),
            fileMedian: round3(summary.volatility.fileMedian),
            measuredComponentCount: summary.volatility.measuredComponentCount,
          },
        }
      : {}),
    ...(summary.scope ? { outOfScopeComponentCount: summary.scope.outOfScopeComponentCount } : {}),
  };
}

function summariseLayering(report: LayeringReport, facadePartition: LayeringPartitionCounts): LayeringReportSummary {
  const { summary } = report;
  return {
    componentCount: summary.componentCount,
    componentEdgeCount: summary.componentEdgeCount,
    levelCount: summary.levelCount,
    facadePartition,
    coverage: round3(summary.coverage),
    coherence: round3(summary.coherence),
    knotCount: summary.knotCount,
    backEdgeCount: summary.backEdgeCount,
    abstractionBypassCount: summary.abstractionBypassCount,
    compositionCycleCount: summary.compositionCycleCount,
    islandCount: summary.islandCount,
    layerSkipCount: summary.layerSkipCount,
    violationCount: summary.violationCount,
    ...(summary.scope ? { outOfScopeFindingCount: summary.scope.outOfScopeFindingCount } : {}),
  };
}

function layeringViolations(report: LayeringReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map((v): ArchitectureViolation => toLayeringArchitectureViolation(v));
}

function toLayeringArchitectureViolation(v: DomainLayeringViolation): ArchitectureViolation {
  switch (v.kind) {
    case "knot":
      return {
        detector: "layering",
        kind: "knot",
        components: v.components.slice(0, LAYERING_KNOT_MEMBER_LIMIT),
        evidence: {
          feedbackArcSet: v.feedbackArcSet.slice(0, LAYERING_FEEDBACK_EDGE_LIMIT).map(toLayeringFeedbackEdge),
          cutEdgeCount: v.cutEdgeCount,
          levelsAfterCut: v.levelsAfterCut,
          memberCount: v.components.length,
          ...(v.outOfScopeMemberCount !== undefined ? { outOfScopeMemberCount: v.outOfScopeMemberCount } : {}),
          ...(v.outOfScopeFeedbackEdgeCount !== undefined
            ? { outOfScopeFeedbackEdgeCount: v.outOfScopeFeedbackEdgeCount }
            : {}),
          drillDown: { ...v.drillDown, hint: LAYERING_KNOT_DRILL_DOWN_HINT },
        },
      };
    case "backEdge":
      return toLayeringBackEdgeViolation(v);
    case "abstractionBypass":
      return {
        detector: "layering",
        kind: "abstractionBypass",
        sourceComponent: v.sourceComponent,
        targetComponent: v.targetComponent,
        evidence: {
          bypassedComponent: v.bypassedComponent,
          concreteAbstractness: round3(v.concreteAbstractness),
          bypassedAbstractness: round3(v.bypassedAbstractness),
          callWeight: v.callWeight,
        },
      };
    case "compositionCycle":
      return {
        detector: "layering",
        kind: "compositionCycle",
        components: v.components.slice(0, LAYERING_KNOT_MEMBER_LIMIT),
        evidence: {
          nestedPairs: v.nestedPairs.slice(0, LAYERING_NESTED_PAIR_LIMIT),
          memberCount: v.components.length,
          nestedPairCount: v.nestedPairs.length,
          ...(v.outOfScopeMemberCount !== undefined ? { outOfScopeMemberCount: v.outOfScopeMemberCount } : {}),
        },
      };
    case "island":
      return {
        detector: "layering",
        kind: "island",
        component: v.component,
        evidence: {
          height: v.height,
          depth: v.depth,
          afferentCount: v.afferentCount,
          instability: round3(v.instability),
        },
      };
    case "layerSkip":
      return {
        detector: "layering",
        kind: "layerSkip",
        sourceComponent: v.sourceComponent,
        targetComponent: v.targetComponent,
        evidence: {
          sourceLevel: v.sourceLevel,
          targetLevel: v.targetLevel,
          skippedLevels: v.skippedLevels,
          callWeight: v.callWeight,
        },
      };
  }
}

function toLayeringBackEdgeViolation(v: DomainLayeringBackEdgeViolation): LayeringBackEdgeArchitectureViolation {
  return {
    detector: "layering",
    kind: "backEdge",
    sourceComponent: v.sourceComponent,
    targetComponent: v.targetComponent,
    evidence: {
      callWeight: v.callWeight,
      counterFlowWeight: v.counterFlowWeight,
      fileEdgeCount: v.fileEdgeCount,
      fileEdges: v.fileEdges,
    },
  };
}

/**
 * The knot view (bd tea-rags-mcp-r8hme.38): the lookup's full lists paged at
 * `[offset, offset + limit)` — members and cut edges by the same window,
 * back-edges capped at `limit` — the counts kept before paging.
 */
function knotView(
  lookup: Exclude<LayeringKnotLookup, { kind: "unknownComponent" }>,
  limit: number,
  offset: number,
): ArchitectureKnotView {
  const head = {
    component: lookup.component,
    inKnot: lookup.kind === "inKnot",
    level: lookup.position.level,
    depth: lookup.position.depth,
    offset,
    limit,
  };
  if (lookup.kind === "notInKnot") return head;
  const { knot } = lookup;
  const end = offset + limit;
  const hasMore = end < knot.components.length || end < knot.feedbackArcSet.length;
  return {
    ...head,
    knot: {
      components: knot.components.slice(offset, end),
      memberCount: knot.components.length,
      feedbackArcSet: knot.feedbackArcSet.slice(offset, end).map(toLayeringFeedbackEdge),
      cutEdgeCount: knot.cutEdgeCount,
      levelsAfterCut: knot.levelsAfterCut,
      composition: knot.composition,
      backEdges: knot.backEdges.slice(0, limit).map(toLayeringBackEdgeViolation),
      ...(knot.outOfScopeMemberCount !== undefined ? { outOfScopeMemberCount: knot.outOfScopeMemberCount } : {}),
      ...(knot.outOfScopeFeedbackEdgeCount !== undefined
        ? { outOfScopeFeedbackEdgeCount: knot.outOfScopeFeedbackEdgeCount }
        : {}),
      ...(hasMore ? { nextOffset: end } : {}),
    },
  };
}

function toLayeringFeedbackEdge(edge: DomainLayeringFeedbackEdge) {
  return {
    sourceComponent: edge.sourceComponent,
    targetComponent: edge.targetComponent,
    callWeight: edge.callWeight,
    fileEdges: edge.fileEdges,
  };
}

function mainSequenceViolations(report: MainSequenceReport, limit: number): ArchitectureViolation[] {
  return report.violations.slice(0, limit).map(
    (v): ArchitectureViolation => ({
      detector: "mainSequence",
      component: v.component,
      componentKind: v.kind,
      facadeRelPath: v.facadeRelPath,
      evidence: {
        zone: v.zone,
        distance: v.distance,
        abstractness: v.abstractness,
        instability: v.instability,
        abstractTypeCount: v.abstractTypeCount,
        concreteTypeCount: v.concreteTypeCount,
        afferentCount: v.afferentCount,
        efferentCount: v.efferentCount,
        fileCount: v.fileCount,
        unmeasuredFileCount: v.unmeasuredFileCount,
        ...(v.volatility
          ? {
              volatility: {
                value: round3(v.volatility.value),
                measuredFileCount: v.volatility.measuredFileCount,
                threshold: round3(v.volatility.threshold),
                label: v.volatility.label,
              },
            }
          : {}),
      },
    }),
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
