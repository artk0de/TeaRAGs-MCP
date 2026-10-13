/**
 * ArchitectureReportOps — the query behind `get_architecture_report`
 * (bd tea-rags-mcp-94hd9).
 *
 * Reads the whole file dependency graph from a codegraph handle, runs the
 * boundary detectors owned by the codegraph trajectory — Stable Dependencies,
 * leaking abstraction (bd tea-rags-mcp-jetrd), the main sequence (bd
 * tea-rags-mcp-r8hme.8, its zone of pain gated on git volatility by bd
 * tea-rags-mcp-r8hme.14), hub-like dependencies (bd tea-rags-mcp-r8hme.47) and, over the temporal co-change sub-graph, silent
 * coupling (bd tea-rags-mcp-b4dcz) — and shapes
 * the typed report DTO. Lives in `api/internal` because it bridges the trajectory's
 * detectors and the public DTO — the one layer allowed to import both.
 *
 * Collection resolution and the READ handle are the caller's
 * (`GraphFacade#getArchitectureReport` routes through the same daemon-proxied
 * reader `find_cycles` uses), so this class never opens a DuckDB file.
 */

import type {
  FileDependencyEdge,
  FileDependencyGraph,
  RelPath,
  TemporalCochangeGraph,
  TypeNameRow,
} from "../../../contracts/types/codegraph.js";
import {
  buildDependencyNormFilePrimaryTypes,
  buildDependencyNormFileRoles,
} from "../../../domains/explore/naming-lexicon/index.js";
import {
  buildComponentGraph,
  buildLayeringModel,
  buildLayerMap,
  computeDependencyNorms,
  computePropagationCost,
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectComponentStableDependencyViolations,
  detectConventionPrivacyLeaks,
  detectHubLikeDependencies,
  detectLayeringViolations,
  detectLeakingAbstractions,
  detectMainSequenceDeviations,
  domainBoundaryFileEdges,
  inducedDomainGraph,
  layeringKnotKeepCosts,
  lookupLayeringKnot,
  NON_PRODUCTION_REASON,
  TEST_SUPPORT_REASON,
  type ComponentGraph,
  type ComponentStableDependenciesReport,
  type ConventionPrivacyReport,
  type DependencyNormsReport,
  type HubLikeDependencyReport,
  type LayeringKnot,
  type LayeringKnotLookup,
  type LayeringModel,
  type LayeringReport,
  type LeakingAbstractionReport,
  type MainSequenceReport,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  assessGraphCochangeSignificance,
  detectSilentCoupling,
  linkImportedCochangePairs,
  oneWalkedViolationImporters,
  type CochangeSignificance,
  type SilentCouplingReport,
} from "../../../domains/trajectory/codegraph/temporal/index.js";
import type {
  ArchitectureDomainBoundaryEdge,
  ArchitectureDomainReport,
  ArchitectureKnotView,
  ArchitectureRootCause,
  ArchitectureViolation,
  ArchitectureViolationImpactTierReportSummary,
  GetArchitectureReportRequest,
  GetArchitectureReportResponse,
} from "../../public/dto/architecture.js";
import { UnknownArchitectureComponentError } from "../../public/errors.js";
import {
  deriveArchitectureComponentFacts,
  type DeclaredTestDependencyLookup,
  type IndexedFileImportLookup,
  type ProductionArchitectureGraph,
} from "./architecture-facts.js";
import {
  readArchitectureGraphFacts,
  type ArchitectureGraphFacts,
  type ArchitectureReportGraphDb,
} from "./architecture-graph-facts.js";
import {
  architectureViolationCarrierFiles,
  ComponentEdgeCarrierIndex,
  FileMaintenanceCostModel,
  maintenanceCostFamily,
  rankFamiliesByMaintenanceCost,
  type GitFileMaintenanceSignalLookup,
  type MaintenanceCostFamily,
  type MaintenanceCostFamilyOptions,
} from "./architecture-maintenance-cost.js";
import {
  buildArchitectureKnotMembership,
  changeReasonsView,
  compareCodePoints,
  findingsInKnot,
  hubLikeDependencyViolations,
  isDocumentationPath,
  knotView,
  leakRootCauses,
  leakViolations,
  mainSequenceViolations,
  normsDto,
  normsViolations,
  sdpRootCauses,
  sdpViolations,
  silentRootCauses,
  silentViolations,
  STABLE_DEPENDENCIES_EXCLUSION_REASONS,
  summariseHubLikeDependency,
  summariseLayering,
  summariseLeaks,
  summariseMainSequence,
  summarisePropagationCost,
  summariseSilentCoupling,
  summariseSplitMerge,
  summariseStableDependencies,
  toLayeringArchitectureViolation,
  type ArchitectureDetectorReports,
} from "./architecture-report/index.js";
import {
  ARCHITECTURE_IMPACT_TIER_NOT_APPLICABLE,
  ArchitectureViolationImpactTierModel,
  countImpactTiers,
  highestImpactTier,
  impactTierOrder,
  reachCutSummary,
} from "./architecture-violation-impact-tier.js";
import {
  runShotgunSurgery,
  shotgunSurgeryViolations,
  summariseShotgunSurgery,
  type ShotgunSurgeryRun,
} from "./shotgun-surgery-findings.js";

export {
  isDocumentationPath,
  LAYERING_FEEDBACK_EDGE_LIMIT,
  LAYERING_KNOT_MEMBER_LIMIT,
  LAYERING_NESTED_PAIR_LIMIT,
  buildArchitectureKnotMembership,
  silentCouplingArchitectureViolations,
  type ArchitectureKnotMembership,
} from "./architecture-report/index.js";

/** Default `GetArchitectureReportRequest.limit`. */
export const DEFAULT_ARCHITECTURE_REPORT_LIMIT = 50;

type ArchitectureReportScope = Pick<
  GetArchitectureReportRequest,
  "pathPattern" | "domain" | "norms" | "limit" | "layerMap" | "knotOf" | "offset" | "changeReasons"
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

/**
 * The history lookups one report judgement may read beside its graph facts —
 * see {@link ArchitectureReportOps#build} for what each one gates. An edge
 * overlay does not change them.
 */
export interface ArchitectureReportHistoryLookups {
  readImportSpecifiers?: ModuleImportSpecifierLookup;
  readFileCommitCounts?: GitFileCommitCountLookup;
  readFileMaintenanceSignals?: GitFileMaintenanceSignalLookup;
  /**
   * The co-change gate silent coupling and the impact tiers read, when the
   * caller already holds one — a review passes its composed query/full gate
   * (bd tea-rags-mcp-r8hme.53 T2). Absent = the judgement runs the full family.
   */
  cochangeSignificance?: CochangeSignificance;
}

/** A family's full list — the maintenance-cost ranking caps it, after ordering (bd tea-rags-mcp-r8hme.20). */
const UNCAPPED = Number.POSITIVE_INFINITY;

/** The lookup, read at most once however many consumers ask. */
export function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return async () => (pending ??= read());
}

/** Whether any family the report lists holds a violation — the maintenance read is skipped otherwise. */
function hasArchitectureFindings(view: ArchitectureFindingsView, runs: ArchitectureDetectorRuns): boolean {
  const { findings } = view;
  return (
    findings.sdp.violations.length > 0 ||
    findings.leaks.violations.length > 0 ||
    findings.privacy.violations.length > 0 ||
    findings.silent.violations.length > 0 ||
    // Knot mode does not list spreads, so they rank nothing there.
    (!runs.knotLookup && runs.shotgun.built && runs.shotgun.report.findings.length > 0) ||
    findings.mainSequence.violations.length > 0 ||
    findings.hubLikeDependency.violations.length > 0 ||
    (findings.layering?.violations.length ?? 0) > 0 ||
    (runs.norms?.findings.length ?? 0) > 0
  );
}

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
   * change verdict. The same single read attaches churn to hub-like
   * dependencies (bd tea-rags-mcp-r8hme.47), asked only when a hub exists.
   *
   * `readFileMaintenanceSignals`, when given, ranks every violation family
   * by maintenance cost (bd tea-rags-mcp-r8hme.20) and tags each violation
   * with its score. One payload read serves both it and the volatility gate
   * (whose commit counts it carries), and it is read only when some family
   * has a violation to rank.
   *
   * `readIndexedFileImports`, when given, lets the production graph drop
   * test support — files only tests and other test support import (bd
   * tea-rags-mcp-89k7k.35.3). Absent, no test importer is known and nothing
   * is dropped as test support. `readDeclaredTestDependencies` adds the
   * manifests' development-only packages to the evidence it rests on.
   */
  async build(
    graphDb: ArchitectureReportGraphDb,
    request: ArchitectureReportScope,
    readImportSpecifiers?: ModuleImportSpecifierLookup,
    readFileCommitCounts?: GitFileCommitCountLookup,
    readFileMaintenanceSignals?: GitFileMaintenanceSignalLookup,
    readIndexedFileImports?: IndexedFileImportLookup,
    readDeclaredTestDependencies?: DeclaredTestDependencyLookup,
  ): Promise<GetArchitectureReportResponse> {
    const facts = await readArchitectureGraphFacts(
      graphDb,
      request,
      readIndexedFileImports,
      readDeclaredTestDependencies,
    );
    return this.judge(facts, request, { readImportSpecifiers, readFileCommitCounts, readFileMaintenanceSignals });
  }

  /**
   * Judge one graph-facts snapshot and shape the report — every detector
   * family, pure over `facts` plus the history lookups (bd
   * tea-rags-mcp-89k7k.35.4). The index's own facts give the report
   * {@link ArchitectureReportOps#build} returns; facts derived by
   * `applyEdgeOverlay` give the same report over a working tree's edges, so
   * a diff can be judged base-versus-overlay with the full detector set.
   */
  async judge(
    facts: ArchitectureGraphFacts,
    request: ArchitectureReportScope,
    lookups: ArchitectureReportHistoryLookups = {},
  ): Promise<GetArchitectureReportResponse> {
    const { readImportSpecifiers, readFileCommitCounts, readFileMaintenanceSignals } = lookups;
    const maintenanceSignals = readFileMaintenanceSignals ? readOnce(readFileMaintenanceSignals) : undefined;
    const commitCounts = maintenanceSignals
      ? async () => new Map([...(await maintenanceSignals())].map(([relPath, s]) => [relPath, s.commitCount]))
      : readFileCommitCounts;
    const scope = this.scopeGraph(facts.production, request);
    const runs = await this.runDetectors(
      facts,
      scope,
      request,
      readImportSpecifiers,
      commitCounts,
      lookups.cochangeSignificance,
    );
    const view = this.projectFindings(runs, request);
    const costModel =
      maintenanceSignals && hasArchitectureFindings(view, runs)
        ? new FileMaintenanceCostModel(await maintenanceSignals())
        : undefined;
    return this.shapeResponse(scope, runs, view, request, costModel);
  }

  /**
   * The graph the report judges: the production read every detector sees (bd
   * tea-rags-mcp-r8hme.9), and in domain mode (bd tea-rags-mcp-xb669.1) the
   * induced sub-graph plus the whole-graph partition its border is positioned
   * against — the one thing an internal view cannot recompute.
   */
  private scopeGraph(
    production: ProductionArchitectureGraph,
    request: ArchitectureReportScope,
  ): ScopedArchitectureGraph {
    const whole =
      request.domain === undefined
        ? null
        : buildWholeGraphPartition(production.graph, request.domain, request.pathPattern);
    return {
      production,
      whole,
      graph: whole ? inducedDomainGraph(production.graph, whole.domainRoot) : production.graph,
    };
  }

  /**
   * Every detector family over one scoped graph, in judging order. This is
   * the seam a new detector joins: a field on
   * {@link ArchitectureDetectorRuns}, its detect call here, its summary and
   * violation mappings in {@link ArchitectureReportOps#shapeResponse} — a
   * one-family change, never more of {@link ArchitectureReportOps#build}.
   * Pure over `facts`: it reads no graph DB, only the history lookups.
   */
  private async runDetectors(
    facts: ArchitectureGraphFacts,
    scope: ScopedArchitectureGraph,
    request: ArchitectureReportScope,
    readImportSpecifiers?: ModuleImportSpecifierLookup,
    readFileCommitCounts?: GitFileCommitCountLookup,
    givenCochangeSignificance?: CochangeSignificance,
  ): Promise<ArchitectureDetectorRuns> {
    const { graph } = scope;
    // Facade classification + components (bd tea-rags-mcp-r8hme.7): the
    // report-owned derivation in `architecture-facts.ts`.
    const { leaks, components } = deriveArchitectureComponentFacts(graph, request.pathPattern);
    const sdp = detectComponentStableDependencyViolations(components, { sourcePathPattern: request.pathPattern });
    // One commit-count read, shared by every detector that asks for it.
    const commitCounts = readFileCommitCounts ? readOnce(readFileCommitCounts) : undefined;
    const mainSequence = await detectVolatilityGatedMainSequence(
      components,
      graph.files,
      request.pathPattern,
      commitCounts,
    );
    const { layeringModel, layering, knotLookup } = runArchitectureLayering(components, graph.files, request);
    const hubLikeDependency = await detectHubLikeDependenciesWithChurn(
      components,
      request.pathPattern,
      commitCounts,
      layering.summary.foundation,
    );
    // An aggregate over the same graph and partition (bd tea-rags-mcp-r8hme.49),
    // not a violation family: nothing in it is ranked or capped by finding.
    const propagationCost = computePropagationCost(graph, { componentOf: components.componentOf });
    const privacy = detectScopedConventionPrivacyLeaks(facts, scope, request.pathPattern);
    // One co-change read feeds both temporal detectors: silent coupling's
    // pairs and the split/merge verdicts' bundle membership.
    const { cochange } = facts;
    // One full-family significance pass serves silent coupling (both of its
    // runs: relinking asset imports changes no pair's support) and the
    // violation impact tiers (bd tea-rags-mcp-r8hme.53). F₂'s existence check
    // is the build's own liveness — the builder stores only paths tracked at
    // its HEAD and not deleted in the working tree.
    // A caller-held gate (a review's composed family) replaces it.
    const cochangeSignificance =
      givenCochangeSignificance ?? assessGraphCochangeSignificance(cochange, { kind: "full" });
    const silent = await detectSilentCouplingSeeingAssetImports(
      cochange,
      cochangeSignificance,
      graph,
      request,
      readImportSpecifiers,
    );
    // Shotgun surgery (bd tea-rags-mcp-r8hme.50): the same bundles, over the
    // partition split/merge judges and its component graph.
    const shotgun = runShotgunSurgery(cochange, components, request.pathPattern);
    // Dependency norms (bd tea-rags-mcp-rpx0v), read-time only when asked:
    // roles from each file's primary type, ledgers and verdicts off the graph
    // already in memory. The same partition decides sameDomain locality.
    // Findings scope by the request's pathPattern, the way every other
    // detector scopes (bd tea-rags-mcp-mv8yv).
    const norms = facts.typeNameRows
      ? computeReportNorms(facts.typeNameRows, graph, components.componentOf, request.pathPattern)
      : undefined;
    return {
      leaks,
      components,
      sdp,
      mainSequence,
      hubLikeDependency,
      propagationCost,
      privacy,
      cochange,
      cochangeSignificance,
      silent,
      shotgun,
      layeringModel,
      layering,
      knotLookup,
      norms,
    };
  }

  /**
   * The paging every capped list reads, and knot mode's projection of the
   * runs (bd tea-rags-mcp-r8hme.39): the WHOLE knot the lookup found —
   * members before any scope projection — decides which findings sit inside
   * it; the summaries keep reading the unfiltered reports.
   */
  private projectFindings(runs: ArchitectureDetectorRuns, request: ArchitectureReportScope): ArchitectureFindingsView {
    const { knotLookup } = runs;
    const domainKnot =
      knotLookup?.kind === "inKnot"
        ? runs.layeringModel.knots.find((k) => k.components.includes(knotLookup.component))
        : undefined;
    const findings = knotLookup
      ? findingsInKnot(
          {
            sdp: runs.sdp,
            leaks: runs.leaks,
            privacy: runs.privacy,
            silent: runs.silent,
            mainSequence: runs.mainSequence,
            hubLikeDependency: runs.hubLikeDependency,
          },
          buildArchitectureKnotMembership(domainKnot?.components ?? [], runs.components),
          request.offset ?? 0,
        )
      : {
          sdp: runs.sdp,
          leaks: runs.leaks,
          privacy: runs.privacy,
          silent: runs.silent,
          mainSequence: runs.mainSequence,
          hubLikeDependency: runs.hubLikeDependency,
          layering: runs.layering,
        };
    return {
      limit: request.limit ?? DEFAULT_ARCHITECTURE_REPORT_LIMIT,
      offset: request.offset ?? 0,
      domainKnot,
      findings,
    };
  }

  /** The response: per-detector summaries, the capped root causes and violations, and the views the request asked for. */
  private shapeResponse(
    scope: ScopedArchitectureGraph,
    runs: ArchitectureDetectorRuns,
    view: ArchitectureFindingsView,
    request: ArchitectureReportScope,
    costModel?: FileMaintenanceCostModel,
  ): GetArchitectureReportResponse {
    const { production, whole } = scope;
    const { findings, limit, offset, domainKnot } = view;
    const carrierIndex = new ComponentEdgeCarrierIndex(runs.components.componentOf, runs.components.dependencies);
    const tierModel = buildImpactTierModel(runs, carrierIndex);
    const violations = rankArchitectureViolationsByMaintenanceCost(
      runs,
      findings,
      limit,
      costModel,
      carrierIndex,
      tierModel,
    );
    return {
      ...(request.pathPattern ? { pathPattern: request.pathPattern } : {}),
      summary: summariseArchitectureDetectors(production, runs, limit, tierModel),
      rootCauses: tierArchitectureRootCauses(
        [
          ...sdpRootCauses(findings.sdp, limit),
          ...leakRootCauses(findings.leaks, limit),
          ...silentRootCauses(findings.silent, limit),
        ],
        findings,
        tierModel,
      ),
      violations,
      // The layer map VIEW only when asked (bd tea-rags-mcp-r8hme.26) — a full
      // map never bloats an unqualified report. Same partition the layering
      // detector judges (bd tea-rags-mcp-r8hme.30), so its
      // boundary edges carry levels consistent with the summary.
      ...(request.layerMap ? { layerMap: buildLayerMap(runs.components, production.graph, request.layerMap) } : {}),
      // The knot VIEW only when asked (bd tea-rags-mcp-r8hme.38), paged here.
      // Keep costs price the page's cut edges on the WHOLE knot (bd
      // tea-rags-mcp-r8hme.40), whatever projection the page shows.
      ...(runs.knotLookup ? { knot: architectureKnotView(runs.knotLookup, runs, domainKnot, limit, offset) } : {}),
      // The domain block only in domain mode (bd tea-rags-mcp-xb669.1): the
      // domain's own layering counts plus its border against the system.
      ...(whole ? { domain: domainView(whole, runs.components, runs.layering) } : {}),
      // The norms view only when asked (bd tea-rags-mcp-rpx0v) — the
      // project's own dependency precedents, judged per typed file edge.
      ...(runs.norms ? { norms: normsDto(runs.norms) } : {}),
      // The change-reasons view only when asked (bd tea-rags-mcp-psh3j) — the
      // same co-change read and partition every temporal detector judges.
      ...(request.changeReasons
        ? { changeReasons: changeReasonsView(runs.cochange, runs.components.componentOf, limit) }
        : {}),
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
        testSupport: {
          excludedFileCount: 0,
          excludedEdgeCount: 0,
          testOnlyDependencyCount: 0,
          reason: TEST_SUPPORT_REASON,
        },
        impactTiers: {
          built: false,
          reason: "noCochangeHistory",
          notApplicable: ARCHITECTURE_IMPACT_TIER_NOT_APPLICABLE,
        },
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
          exclusionReasons: STABLE_DEPENDENCIES_EXCLUSION_REASONS,
        },
        leakingAbstraction: summariseLeaks(
          detectLeakingAbstractions({ files: [], edges: [] }),
          detectConventionPrivacyLeaks([]),
          0,
        ),
        silentCoupling: summariseSilentCoupling(detectSilentCoupling({ meta: null, edges: [] }, []), 0),
        splitMerge: { built: false, reason: "noCochangeBuild" },
        shotgunSurgery: { built: false, reason: "noCochangeBuild" },
        mainSequence: summariseMainSequence(
          detectMainSequenceDeviations(buildComponentGraph({ files: [], edges: [] }, []), []),
        ),
        hubLikeDependency: summariseHubLikeDependency(
          detectHubLikeDependencies(buildComponentGraph({ files: [], edges: [] }, [])),
        ),
        propagationCost: summarisePropagationCost(computePropagationCost({ files: [], edges: [] }), 0),
        layering: summariseLayering(detectLayeringViolations(buildComponentGraph({ files: [], edges: [] }, []), [])),
      },
      rootCauses: [],
      violations: [],
    };
  }
}

/**
 * The graph one report judges: the production read every detector sees, and
 * in domain mode the induced sub-graph plus the whole-graph partition
 * ({@link WholeGraphPartition}) its border is positioned against.
 */
interface ScopedArchitectureGraph {
  production: ProductionArchitectureGraph;
  /** Null outside domain mode (bd tea-rags-mcp-xb669.1). */
  whole: WholeGraphPartition | null;
  graph: FileDependencyGraph;
}

/**
 * Every detector family's report over one scoped graph — the one structure a
 * new detector joins: a field here, a detect call in
 * {@link ArchitectureReportOps#runDetectors}, a summary and a violation
 * mapping in {@link ArchitectureReportOps#shapeResponse}.
 */
interface ArchitectureDetectorRuns {
  /** Facade classification + the component partition (bd tea-rags-mcp-r8hme.7). */
  leaks: LeakingAbstractionReport;
  /** The ONE DOMAIN partition every component detector judges — SDP, main sequence, hub, shotgun, split/merge, layering, norms (bd tea-rags-mcp-r8hme.52.7). */
  components: ComponentGraph;
  sdp: ComponentStableDependenciesReport;
  mainSequence: MainSequenceReport;
  hubLikeDependency: HubLikeDependencyReport;
  /** MacCormack propagation cost over the same graph, broken down by the same partition (bd tea-rags-mcp-r8hme.49). */
  propagationCost: ReturnType<typeof computePropagationCost>;
  privacy: ConventionPrivacyReport;
  /** One co-change read feeds both temporal detectors: silent coupling's pairs and the split/merge verdicts' bundle membership. */
  cochange: TemporalCochangeGraph;
  /** The full-family co-change gate over `cochange`; undefined when the read carries no bundle history. */
  cochangeSignificance: CochangeSignificance | undefined;
  silent: SilentCouplingReport;
  /** Shotgun surgery over the same co-change read (bd tea-rags-mcp-r8hme.50). */
  shotgun: ShotgunSurgeryRun;
  /** The layering model over `components` — the knot view reads the same model. */
  layeringModel: LayeringModel;
  layering: LayeringReport;
  /**
   * Present only in knot mode (bd tea-rags-mcp-r8hme.38); an unknown
   * component throws before the runs leave
   * {@link ArchitectureReportOps#runDetectors}, so the view-facing shapes can
   * assume a resolved lookup.
   */
  knotLookup: Exclude<LayeringKnotLookup, { kind: "unknownComponent" }> | undefined;
  /** Read-time only when asked (bd tea-rags-mcp-rpx0v). */
  norms: DependencyNormsReport | undefined;
}

/**
 * The paging every capped list reads, and knot mode's projection of the runs
 * (bd tea-rags-mcp-r8hme.39): the findings narrowed to the knot — the
 * layering report absent there, its back-edges riding the knot view — plus
 * the whole knot whose keep costs price the page's cut edges (bd
 * tea-rags-mcp-r8hme.40).
 */
interface ArchitectureFindingsView {
  limit: number;
  offset: number;
  domainKnot: LayeringKnot | undefined;
  findings: ArchitectureDetectorReports;
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
  significance: CochangeSignificance | undefined,
  production: FileDependencyGraph,
  request: ArchitectureReportScope,
  readImportSpecifiers: ModuleImportSpecifierLookup | undefined,
): Promise<SilentCouplingReport> {
  const walkedFiles = production.files;
  const options = {
    sourcePathPattern: request.pathPattern,
    isDocumentation: isDocumentationPath,
    fileDependencyEdges: production.edges,
    ...(significance ? { significance } : {}),
  };
  const first = detectSilentCoupling(cochange, walkedFiles, options);
  if (!readImportSpecifiers) return first;
  const importers = oneWalkedViolationImporters(first.violations, walkedFiles);
  if (importers.length === 0) return first;
  const linked = linkImportedCochangePairs(cochange, await readImportSpecifiers(importers));
  return detectSilentCoupling(linked, walkedFiles, options);
}

/** The main-sequence family: commit counts read only when the ungated judgement puts a component in the zone of pain. */
async function detectVolatilityGatedMainSequence(
  components: ComponentGraph,
  files: FileDependencyGraph["files"],
  pathPattern: ArchitectureReportScope["pathPattern"],
  commitCounts: GitFileCommitCountLookup | undefined,
): Promise<MainSequenceReport> {
  // Same components, A from the walker's type census (bd tea-rags-mcp-r8hme.8),
  // the zone of pain gated on git volatility (bd tea-rags-mcp-r8hme.14).
  const mainSequenceOptions = { sourcePathPattern: pathPattern };
  const ungatedMainSequence = detectMainSequenceDeviations(components, files, mainSequenceOptions);
  return commitCounts && ungatedMainSequence.summary.painCount > 0
    ? detectMainSequenceDeviations(components, files, {
        ...mainSequenceOptions,
        fileVolatility: await commitCounts(),
      })
    : ungatedMainSequence;
}

/** The hub-like dependency family over the report's components, churn attached as evidence. */
async function detectHubLikeDependenciesWithChurn(
  components: ComponentGraph,
  pathPattern: ArchitectureReportScope["pathPattern"],
  commitCounts: GitFileCommitCountLookup | undefined,
  foundation: LayeringReport["summary"]["foundation"],
): Promise<HubLikeDependencyReport> {
  // Same components, both Ca and Ce past adaptive cuts (bd tea-rags-mcp-r8hme.47);
  // churn rides along as evidence, read only when a hub exists. Ce leaves out
  // the layering's measured foundation, terminals included (bd tea-rags-mcp-g77p3).
  const hubOptions = {
    sourcePathPattern: pathPattern,
    foundationComponents: new Set([...(foundation?.components ?? []), ...(foundation?.terminalComponents ?? [])]),
  };
  const ungatedHubs = detectHubLikeDependencies(components, hubOptions);
  return commitCounts && ungatedHubs.summary.violationCount > 0
    ? detectHubLikeDependencies(components, { ...hubOptions, fileVolatility: await commitCounts() })
    : ungatedHubs;
}

/**
 * Convention-privacy leaks over the production member edges, held inside the
 * domain border in domain mode (bd tea-rags-mcp-xb669.1).
 */
function detectScopedConventionPrivacyLeaks(
  facts: ArchitectureGraphFacts,
  scope: ScopedArchitectureGraph,
  pathPattern: ArchitectureReportScope["pathPattern"],
): ConventionPrivacyReport {
  const { whole, graph } = scope;
  const { nonProduction } = scope.production;
  const { memberEdges, classHierarchy } = facts;
  // Domain mode keeps convention-privacy judgement inside the border too:
  // a member edge reaching outside is the domain USING the system, not a
  // privacy leak of the system the domain reports on.
  const domainFiles = whole ? new Set(graph.files.map((f) => f.relPath)) : null;
  return detectConventionPrivacyLeaks(
    memberEdges.filter(
      (e) =>
        !nonProduction.ignores(e.sourceRelPath) &&
        !nonProduction.ignores(e.targetRelPath) &&
        (!domainFiles || (domainFiles.has(e.sourceRelPath) && domainFiles.has(e.targetRelPath))),
    ),
    {
      sourcePathPattern: pathPattern,
      // The subclass exemption's ancestry (bd tea-rags-mcp-r8hme.41): the
      // persisted hierarchy, read only when a Python candidate needs it.
      ...(classHierarchy !== undefined ? { classHierarchy } : {}),
    },
  );
}

/** The layering family's runs: the model, its violations, and the knot lookup knot mode asked for. */
type ArchitectureLayeringRuns = Pick<ArchitectureDetectorRuns, "layeringModel" | "layering" | "knotLookup">;

/**
 * Inferred layering over the report's DOMAIN partition (bd
 * tea-rags-mcp-r8hme.30) and, in knot mode, the knot lookup over the same
 * model (bd tea-rags-mcp-r8hme.38). An unknown component throws here, so the
 * lookup returned is always resolved.
 */
function runArchitectureLayering(
  components: ComponentGraph,
  files: FileDependencyGraph["files"],
  request: ArchitectureReportScope,
): ArchitectureLayeringRuns {
  // Inferred layering over the same DOMAIN partition (bd tea-rags-mcp-r8hme.30,
  // one partition for every component detector since bd tea-rags-mcp-r8hme.52.7).
  // Built once: the knot view reads the same model the detector judges.
  const layeringModel = buildLayeringModel(components);
  const layering = detectLayeringViolations(components, files, {
    sourcePathPattern: request.pathPattern,
    model: layeringModel,
  });
  const knotLookup =
    request.knotOf === undefined
      ? undefined
      : lookupLayeringKnot(components, layeringModel, request.knotOf, {
          sourcePathPattern: request.pathPattern,
        });
  if (knotLookup?.kind === "unknownComponent") throw new UnknownArchitectureComponentError(knotLookup.component);
  return { layeringModel, layering, knotLookup };
}

/**
 * Every violation family, ranked by maintenance cost and capped at `limit`
 * per family — the report's `violations` list.
 */
function rankArchitectureViolationsByMaintenanceCost(
  runs: ArchitectureDetectorRuns,
  findings: ArchitectureDetectorReports,
  limit: number,
  costModel: FileMaintenanceCostModel | undefined,
  carrierIndex: ComponentEdgeCarrierIndex,
  tierModel: ArchitectureViolationImpactTierModel | undefined,
): ArchitectureViolation[] {
  // Each family ranked by maintenance cost (bd tea-rags-mcp-r8hme.20)
  // BEFORE its cap, so the cap keeps the costliest; a family's carriers are
  // the files on the edges that make it (bd tea-rags-mcp-afyku), read off
  // the one partition every detector judges. Every family is scored in ONE
  // population — the shrinkage is estimated over all of the report's
  // violations, uncapped. A new family opts in by adding its full list to
  // `families`.
  //
  // Each violation carries its impact tier (bd tea-rags-mcp-r8hme.53); a
  // family's ranked list is then ordered tier first — stable, so maintenance
  // cost still orders each tier — BEFORE the cap, so a critical violation
  // survives it however cheap its files are.
  const carriersOf = (violation: object): RelPath[] =>
    costModel ? architectureViolationCarrierFiles(violation, carrierIndex) : [];
  const tiered = (violation: ArchitectureViolation, uncapped?: object): ArchitectureViolation =>
    tierModel ? { ...violation, ...tierModel.tagOf(violation, uncapped) } : violation;
  const family = (violations: readonly ArchitectureViolation[], options?: MaintenanceCostFamilyOptions) =>
    maintenanceCostFamily(
      violations.map((v) => tiered(v)),
      carriersOf,
      undefined,
      options,
    );
  const families: MaintenanceCostFamily<ArchitectureViolation>[] = [
    family(sdpViolations(findings.sdp, UNCAPPED)),
    family(leakViolations(findings.leaks, findings.privacy, UNCAPPED)),
    family(silentViolations(findings.silent, UNCAPPED)),
    // Knot mode lists the knot's findings only; a spread is not a knot member.
    // Spreads keep the detector's family-evidence order; cost only tags them.
    ...(runs.knotLookup ? [] : [family(shotgunSurgeryViolations(runs.shotgun, UNCAPPED), { order: "detector" })]),
    family(mainSequenceViolations(findings.mainSequence, UNCAPPED)),
    family(hubLikeDependencyViolations(findings.hubLikeDependency, UNCAPPED)),
    // Ranked on the layering findings: a knot's whole feedback-arc set and a
    // composition cycle's every nested pair, which the listed form caps.
    ...(findings.layering
      ? [
          maintenanceCostFamily(findings.layering.violations, carriersOf, (f) =>
            tiered(toLayeringArchitectureViolation(f), f),
          ),
        ]
      : []),
    ...(runs.norms ? [family(normsViolations(runs.norms, UNCAPPED))] : []),
  ];
  return rankFamiliesByMaintenanceCost(families, costModel).flatMap((ranked) =>
    [...ranked].sort((a, b) => impactTierOrder(a) - impactTierOrder(b)).slice(0, limit),
  );
}

/**
 * The impact-tier model over one report's runs (bd tea-rags-mcp-r8hme.53):
 * the hoisted co-change gate, the partition's full carrier edges, and each
 * file's exact reach from the propagation-cost closure. Undefined when the
 * co-change read carries no bundle history — no tier is claimed then.
 */
function buildImpactTierModel(
  runs: ArchitectureDetectorRuns,
  carrierIndex: ComponentEdgeCarrierIndex,
): ArchitectureViolationImpactTierModel | undefined {
  if (runs.cochangeSignificance === undefined) return undefined;
  const { propagationCost } = runs;
  return new ArchitectureViolationImpactTierModel(
    runs.cochangeSignificance,
    carrierIndex,
    {
      fanInOf: propagationCost.fileVisibilityFanIn,
      admits: propagationCost.admitsVisibilityFanIn,
      fileCount: propagationCost.fileCount,
    },
    isDocumentationPath,
  );
}

/** Each SDP and leak root cause tagged with the highest tier among its member violations, over the full lists. */
function tierArchitectureRootCauses(
  rootCauses: ArchitectureRootCause[],
  findings: ArchitectureDetectorReports,
  tierModel: ArchitectureViolationImpactTierModel | undefined,
): ArchitectureRootCause[] {
  if (!tierModel) return rootCauses;
  const sdp = sdpViolations(findings.sdp, UNCAPPED);
  const leaks = leakViolations(findings.leaks, findings.privacy, UNCAPPED);
  return rootCauses.map((rootCause) => {
    const members =
      rootCause.detector === "stableDependencies"
        ? sdp.filter((v) => v.detector === "stableDependencies" && v.targetComponent === rootCause.targetComponent)
        : rootCause.detector === "leakingAbstraction"
          ? leaks.filter(
              (v) =>
                v.detector === "leakingAbstraction" &&
                v.kind !== "conventionPrivacy" &&
                v.evidence.moduleDir === rootCause.moduleDir,
            )
          : [];
    const tier = highestImpactTier(members.map((v) => tierModel.tagOf(v)));
    return tier === undefined ? rootCause : { ...rootCause, tier };
  });
}

/** Tier counts per tierable detector over the unfiltered runs, with the gate and the cut they were judged by. */
function summariseImpactTiers(
  runs: ArchitectureDetectorRuns,
  tierModel: ArchitectureViolationImpactTierModel | undefined,
): ArchitectureViolationImpactTierReportSummary {
  if (!tierModel || !runs.cochangeSignificance) {
    return { built: false, reason: "noCochangeHistory", notApplicable: ARCHITECTURE_IMPACT_TIER_NOT_APPLICABLE };
  }
  const counted = (violations: readonly ArchitectureViolation[]) =>
    countImpactTiers(violations.map((v) => tierModel.tagOf(v)));
  const { propagationCost } = runs;
  return {
    built: true,
    cochangeSignificance: runs.cochangeSignificance.summary,
    reachCut: reachCutSummary(propagationCost.corePeriphery.visibilityFanIn, propagationCost.fileCount),
    byDetector: {
      stableDependencies: counted(sdpViolations(runs.sdp, UNCAPPED)),
      leakingAbstraction: counted(leakViolations(runs.leaks, runs.privacy, UNCAPPED)),
      layering: countImpactTiers(
        runs.layering.violations.map((f) => tierModel.tagOf(toLayeringArchitectureViolation(f), f)),
      ),
      ...(runs.norms ? { norms: counted(normsViolations(runs.norms, UNCAPPED)) } : {}),
    },
    notApplicable: ARCHITECTURE_IMPACT_TIER_NOT_APPLICABLE,
  };
}

/** The per-detector summaries — each reads its family's unfiltered report, whatever projection the page shows. */
function summariseArchitectureDetectors(
  production: ProductionArchitectureGraph,
  runs: ArchitectureDetectorRuns,
  limit: number,
  tierModel: ArchitectureViolationImpactTierModel | undefined,
): GetArchitectureReportResponse["summary"] {
  return {
    nonProduction: {
      excludedFileCount: production.excludedFileCount,
      excludedEdgeCount: production.excludedEdgeCount,
      reason: NON_PRODUCTION_REASON,
    },
    testSupport: { ...production.testSupport, reason: TEST_SUPPORT_REASON },
    impactTiers: summariseImpactTiers(runs, tierModel),
    stableDependencies: summariseStableDependencies(runs.sdp),
    leakingAbstraction: summariseLeaks(runs.leaks, runs.privacy, limit),
    silentCoupling: summariseSilentCoupling(runs.silent, limit),
    splitMerge: summariseSplitMerge(runs.cochange, runs.components.componentOf),
    shotgunSurgery: summariseShotgunSurgery(runs.shotgun),
    mainSequence: summariseMainSequence(runs.mainSequence),
    hubLikeDependency: summariseHubLikeDependency(runs.hubLikeDependency),
    propagationCost: summarisePropagationCost(runs.propagationCost, limit),
    layering: summariseLayering(runs.layering),
  };
}

/**
 * The knot VIEW knot mode asked for (bd tea-rags-mcp-r8hme.38), paged here.
 * Keep costs price the page's cut edges on the WHOLE knot (bd
 * tea-rags-mcp-r8hme.40), whatever projection the page shows.
 */
function architectureKnotView(
  knotLookup: NonNullable<ArchitectureDetectorRuns["knotLookup"]>,
  runs: ArchitectureDetectorRuns,
  domainKnot: LayeringKnot | undefined,
  limit: number,
  offset: number,
): ArchitectureKnotView {
  return knotView(
    knotLookup,
    runs.components,
    domainKnot?.instabilitySpread ?? 0,
    (edges) => {
      // An inKnot lookup always names a knot of the same model.
      if (!domainKnot) throw new Error("knotOf lookup found a knot the layering model does not hold");
      return layeringKnotKeepCosts(runs.components, runs.layeringModel, domainKnot, edges);
    },
    limit,
    offset,
  );
}

/**
 * The whole-graph partition a domain report positions its border against
 * (bd tea-rags-mcp-xb669.1): the DOMAIN component graph of the entire
 * production graph and the layering model over it, kept because the external
 * side of a border edge is meaningful only in the system the domain sits in.
 */
interface WholeGraphPartition {
  domainRoot: string;
  graph: FileDependencyGraph;
  components: ComponentGraph;
  model: LayeringModel;
}

function buildWholeGraphPartition(
  production: FileDependencyGraph,
  domainRoot: string,
  pathPattern: string | undefined,
): WholeGraphPartition {
  const { components } = deriveArchitectureComponentFacts(production, pathPattern);
  return { domainRoot, graph: production, components, model: buildLayeringModel(components) };
}

/**
 * The domain block (bd tea-rags-mcp-xb669.1): the domain's own layering
 * counts — the same ones `summary.layering` reports — plus its border,
 * aggregated per (inner, external) component with the external side
 * positioned on the whole-graph stack.
 */
function domainView(
  whole: WholeGraphPartition,
  domainComponents: ComponentGraph,
  layering: LayeringReport,
): ArchitectureDomainReport {
  const boundary = domainBoundaryFileEdges(whole.graph, whole.domainRoot);
  return {
    path: whole.domainRoot,
    componentCount: layering.summary.componentCount,
    levelCount: layering.summary.levelCount,
    boundaryOut: aggregateBoundaryEdges(boundary.out, domainComponents, whole, "out"),
    boundaryIn: aggregateBoundaryEdges(boundary.in, domainComponents, whole, "in"),
  };
}

function aggregateBoundaryEdges(
  edges: readonly FileDependencyEdge[],
  domainComponents: ComponentGraph,
  whole: WholeGraphPartition,
  side: "out" | "in",
): ArchitectureDomainBoundaryEdge[] {
  const aggregated = new Map<string, ArchitectureDomainBoundaryEdge>();
  for (const edge of edges) {
    const innerRelPath = side === "out" ? edge.sourceRelPath : edge.targetRelPath;
    const externalRelPath = side === "out" ? edge.targetRelPath : edge.sourceRelPath;
    const innerComponent = domainComponents.componentOf.get(innerRelPath);
    const externalComponent = whole.components.componentOf.get(externalRelPath);
    // Unwalked endpoints carry no component; a border edge between two
    // measured components always has both.
    if (innerComponent === undefined || externalComponent === undefined) continue;
    const key = `${innerComponent}\u0000${externalComponent}`;
    const carried = aggregated.get(key);
    if (carried) {
      carried.callWeight += edge.callWeight;
    } else {
      aggregated.set(key, {
        innerComponent,
        externalComponent,
        externalLevel: whole.model.positions.get(externalComponent)?.level ?? 0,
        callWeight: edge.callWeight,
      });
    }
  }
  return [...aggregated.values()].sort(
    (a, b) =>
      b.callWeight - a.callWeight ||
      compareCodePoints(a.innerComponent, b.innerComponent) ||
      compareCodePoints(a.externalComponent, b.externalComponent),
  );
}

/**
 * Dependency norms, read-time (bd tea-rags-mcp-rpx0v): over the type rows
 * naming's role layer reads anyway (whole project, production paths, read
 * into the graph facts only when norms are asked), each file's
 * PRIMARY type's role, and the verdicts over the graph the report already
 * holds. `componentOf` is the same DOMAIN partition the layering judges, so
 * `sameDomain` locality means "one unit of r8hme.30".
 */
function computeReportNorms(
  rows: readonly TypeNameRow[],
  graph: FileDependencyGraph,
  componentOf: ReadonlyMap<RelPath, string>,
  sourcePathPattern: string | undefined,
): DependencyNormsReport {
  return computeDependencyNorms({
    graph,
    fileRoles: buildDependencyNormFileRoles(rows),
    filePrimaryTypes: buildDependencyNormFilePrimaryTypes(rows),
    componentOf,
    sourcePathPattern,
  });
}
