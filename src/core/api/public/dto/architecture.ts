/**
 * Architecture diagnostics DTOs — `get_architecture_report` (bd tea-rags-mcp-94hd9).
 *
 * The report's finding vocabulary — every violation, root cause, evidence and
 * summary shape — lives in the boundary-diagnostics finding contract
 * (`contracts/types/architecture-report.js`, bd tea-rags-mcp-0e4vf) and is
 * re-exported below, so a new detector shape is added once in the contract
 * instead of hand-synced here. This module keeps the transport-level request.
 *
 * The report answers "is the code laid out correctly", not "is it dangerous to
 * touch" (that is risk-assessment's question). It is a list of typed
 * violations, each carrying the evidence that makes it one, plus root-cause
 * groups and the exclusion summary. Every finding names its `detector`:
 * `stableDependencies` (Stable Dependencies Principle) and
 * `leakingAbstraction` (A4, bd tea-rags-mcp-jetrd — imports past a facade the
 * module's importers adopted) and `silentCoupling` (A2, bd tea-rags-mcp-b4dcz —
 * files that change together with no structural link, judged over the
 * codegraph's temporal co-change sub-graph). Later boundary detectors (epic r8hme) extend the
 * `ArchitectureViolation` / `ArchitectureRootCause` unions and
 * `ArchitectureReportSummary`.
 */

import type { ArchitectureFindingKeyFamily } from "../../../contracts/types/architecture-finding-key.js";
import type {
  ArchitectureLayerMapOptions,
  ArchitectureReportSummary,
  ArchitectureRestructureCompiledOp,
  ArchitectureRestructureOp,
  ArchitectureViolation,
  ArchitectureViolationImpactTier,
  GetArchitectureReportResponse,
  SilentCouplingReportSummary,
} from "../../../contracts/types/architecture-report.js";
import type { SuggestedToolCall } from "../../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import type { ArchitectureChangeSubject } from "./review.js";

export type * from "../../../contracts/types/architecture-report.js";

/** A violation family's name — the key the tool view groups violations by. */
export type ArchitectureReportDetector = ArchitectureViolation["detector"];

/**
 * Every detector, for the `detectors` selector's wire enum. The two
 * assignments below fail compilation when this list and the violation union
 * drift apart in either direction.
 */
export const ARCHITECTURE_REPORT_DETECTORS = [
  "stableDependencies",
  "leakingAbstraction",
  "silentCoupling",
  "shotgunSurgery",
  "mainSequence",
  "hubLikeDependency",
  "layering",
  "norms",
] as const satisfies readonly ArchitectureReportDetector[];
const _everyDetectorListed: readonly (typeof ARCHITECTURE_REPORT_DETECTORS)[number][] =
  [] as ArchitectureReportDetector[];

/** Evidence entries per array the tool view keeps by default. */
export const ARCHITECTURE_REPORT_EVIDENCE_LIMIT = 3;

/** A cap on evidence arrays, or `"all"` for none. */
export type ArchitectureReportEvidenceLimit = number | "all";

/** `summary.silentCoupling` as the tool returns it: the explained pairs' count, the list only on opt-in. */
export type PresentedSilentCouplingReportSummary = Omit<SilentCouplingReportSummary, "explainedPairs"> & {
  /** Every explained pair, uncapped — `excluded.explainedBySharedNeighbour`; the opt-in list is capped at `limit`. */
  explainedPairCount: number;
  explainedPairs?: SilentCouplingReportSummary["explainedPairs"];
};

/**
 * The `get_architecture_report` answer at the TOOL boundary (bd
 * tea-rags-mcp-9ah49). The internal {@link GetArchitectureReportResponse} —
 * read by review_changes, restructure and the violation delta — keeps its flat
 * `violations`; only the tool view groups and trims.
 */
/** Summary blocks a detector owns — the `detectors` selector scopes them. */
type DetectorSummaryKey = Extract<keyof ArchitectureReportSummary, ArchitectureReportDetector>;

export interface GetArchitectureReportToolResponse extends Omit<
  GetArchitectureReportResponse,
  "violations" | "summary"
> {
  /**
   * Evidence lists capped at `evidenceLimit` like the violations' (bd
   * tea-rags-mcp-q1g6s.1), `impactTiers` whole. A detector's block is absent
   * when the `detectors` selector leaves that detector out.
   */
  summary: Omit<ArchitectureReportSummary, DetectorSummaryKey> &
    Partial<Omit<Pick<ArchitectureReportSummary, DetectorSummaryKey>, "silentCoupling">> & {
      silentCoupling?: PresentedSilentCouplingReportSummary;
    };
  /**
   * Per detector, in the report's detector order, each group's rows without
   * the `detector` key; evidence arrays capped at `evidenceLimit`, with a
   * sibling `<key>Count` holding the full length when the row had none.
   */
  violations: Partial<Record<ArchitectureReportDetector, ArchitectureViolation[]>>;
  /** A group's `evidence.drillDown.hint` when every drill-down carried the same one — lifted out of the rows. */
  violationDrillDownHints?: Partial<Record<ArchitectureReportDetector, string>>;
  /** Present when any evidence array was cut. */
  evidenceTrimmed?: { limit: number };
  /** Per group with cut evidence: the same call narrowed to that detector, `evidenceLimit: "all"`. */
  next?: SuggestedToolCall[];
}

export interface GetArchitectureReportRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /**
   * Picomatch glob scoping the judged edges: an edge counts when its SOURCE
   * file matches. Instabilities and facade adoption are always computed over
   * the whole graph.
   */
  pathPattern?: string;
  /**
   * A directory root: judge it AS ITS OWN SYSTEM (bd tea-rags-mcp-xb669.1) —
   * the induced sub-graph, every detector and metric recomputed inside it —
   * distinct from `pathPattern`, which keeps whole-system metrics and only
   * filters findings. `response.domain` carries the domain's border: edges
   * leaving or entering, each naming the external component and its level on
   * the WHOLE-graph stack.
   */
  domain?: string;
  /**
   * Ask for the dependency-norms view (bd tea-rags-mcp-rpx0v): the project's
   * own P(edge | roleSrc, roleDst, locality), judged per file edge —
   * `response.norms` plus `norms` violations for every precedent-less edge.
   * Roles come from each file's primary type (naming's type-role layer);
   * edges touching an untyped or suffix-only file are never judged.
   */
  norms?: boolean;
  /**
   * Ask for the change-reasons view (bd tea-rags-mcp-psh3j): per component,
   * the distinct domains of the tickets that changed it — `response.changeReasons`,
   * modules capped by `limit`. Unavailable on a repo whose commits rarely
   * name a task id.
   */
  changeReasons?: boolean;
  /** Max violations and max root causes returned per detector (default 50); the summary keeps the totals. */
  limit?: number;
  /**
   * Ask for the layer map VIEW (bd tea-rags-mcp-r8hme.26) alongside the
   * violations — `response.layerMap` appears only when requested, so a full
   * map never bloats an unqualified report. Its `scopePathPattern` means
   * "layers of the induced subgraph", deliberately NOT this request's
   * `pathPattern` (judge edges by source, whole-graph instability).
   */
  layerMap?: ArchitectureLayerMapOptions;
  /**
   * A component path as the report names components — ask for the knot VIEW
   * (bd tea-rags-mcp-r8hme.38): the knot holding it in full, members and cut
   * edges paged by `limit` / `offset`. A knot finding's
   * `evidence.drillDown.knotOf` is such a path. Knot mode (bd
   * tea-rags-mcp-r8hme.39): `violations` / `rootCauses` hold only the
   * findings inside the knot, and only on the first page (`offset` 0);
   * `summary` stays whole-project.
   */
  knotOf?: string;
  /**
   * Page start (default 0): skips that many violations per detector, after
   * ranking — pair it with `reportId` to page one judgement. In knot mode it
   * pages the `knotOf` view instead (findings ride the first page only).
   */
  offset?: number;
  /**
   * A previous answer's `reportId` (bd tea-rags-mcp-00309): serve this call
   * from that held judgement — no detector run, no graph read — with this
   * call's view params (`limit`, `offset`). Held in memory by the MCP server
   * (8 reports, ~10 min); a one-process CLI `call` never holds one. A held
   * report the tree, scope or clock no longer matches answers
   * `empty.reason: "reportStale"` — re-call without `reportId`. The tree
   * check compares the working-tree marker's counts, so re-editing an
   * already-changed file goes unnoticed until the report expires.
   */
  reportId?: string;
  /**
   * Tool-view cap on every evidence array of a violation (bd
   * tea-rags-mcp-9ah49): default {@link ARCHITECTURE_REPORT_EVIDENCE_LIMIT},
   * `"all"` = untrimmed. A trimmed group answers a `next` call restoring it.
   */
  evidenceLimit?: ArchitectureReportEvidenceLimit;
  /** Tool-view selector: only these detectors' violation groups come back. */
  detectors?: ArchitectureReportDetector[];
  /** Tool-view opt-in: `summary.silentCoupling.explainedPairs` as a list; default only its count. */
  includeExplainedPairs?: boolean;
  /**
   * Planned-edges MODE (bd tea-rags-mcp-xb669.2): judge each edge a writer is
   * about to add against the indexed graph's dependency norms, BEFORE it is
   * written. File paths only (owner decision 2026-10-11). The detector
   * families are not run — the answer is a
   * {@link GetArchitecturePlannedEdgesResponse}, never a partial report — so
   * no other report option may ride along. At most
   * {@link ARCHITECTURE_PLANNED_EDGE_LIMIT} edges.
   */
  plannedEdges?: ArchitecturePlannedEdge[];
  /**
   * Restructure MODE (bd tea-rags-mcp-r8hme.21): one what-if hypothesis — the
   * ops compile against the CURRENT component partition, the full detector
   * set judges the base facts and the relabelled facts, and the answer is the
   * violation delta ({@link GetArchitectureRestructureResponse}). Only `limit`
   * (subjects listed per side) may ride along. At most
   * {@link ARCHITECTURE_RESTRUCTURE_OP_LIMIT} ops.
   */
  restructure?: ArchitectureRestructureOp[];
  /**
   * Restructure PLAN mode (bd tea-rags-mcp-cm9gt.2): a greedy ordered plan
   * over candidate hypotheses — each round judges prefix ∪ candidate for every
   * remaining candidate and appends the best by net resolved critical, then
   * active, then structural, then smaller blast radius, then id
   * ({@link GetArchitectureRestructurePlanResponse}). Only `limit` (subjects
   * listed per delta side) may ride along. At most
   * {@link ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT} caller candidates;
   * an empty list needs the report's own split/merge candidates included.
   */
  restructurePlan?: {
    candidates: ArchitectureRestructurePlanCandidate[];
    /** Add one candidate per report split / merge verdict (`report:split:<n>`, `report:merge:<n>`). Default true. */
    includeReportCandidates?: boolean;
  };
}

/**
 * Max `GetArchitectureReportRequest.restructure` ops per call. The delta is
 * JOINT — no op of a long list can be credited with any part of it — so a
 * call is one hypothesis, and ranking remedies is one call per remedy. Every
 * call costs two full uncapped detector runs whatever the op count.
 */
export const ARCHITECTURE_RESTRUCTURE_OP_LIMIT = 20;

/** The violation delta of one restructure hypothesis: relabelled run vs base run, by violation key. */
export interface ArchitectureRestructureDelta {
  /** Keys only the relabelled run holds. */
  introducedCount: number;
  /** Keys only the base run holds. */
  resolvedCount: number;
  /** Keys both runs hold — a moved file's file-keyed violations are matched on its base path. */
  persistingCount: number;
  /** introducedCount − resolvedCount: negative = the hypothesis removes violations on balance. */
  net: number;
  /** Per key family, the families that moved. */
  byFamily: Partial<Record<ArchitectureFindingKeyFamily, { introduced: number; resolved: number }>>;
  /** Introduced violations, at most `limit` (default 50). */
  introduced: ArchitectureChangeSubject[];
  /** Resolved violations, at most `limit` (default 50). */
  resolved: ArchitectureChangeSubject[];
}

/** `get_architecture_report` in restructure mode — the hypothesis as compiled and its delta. */
export interface GetArchitectureRestructureResponse {
  workingTree?: WorkingTreeMarker;
  mode: "restructure";
  /** Per op: the files it relabels and the component(s) they land in. Empty when unavailable. */
  hypothesis: ArchitectureRestructureCompiledOp[];
  /** Absent exactly when `unavailable` is set. */
  delta?: ArchitectureRestructureDelta;
  /** No codegraph database to judge — nothing was simulated. */
  unavailable?: "noCodegraph";
}

/** Max caller candidates per `restructurePlan` call. Each round judges every remaining candidate once. */
export const ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT = 50;

/** One caller hypothesis the plan may order: 1..{@link ARCHITECTURE_RESTRUCTURE_OP_LIMIT} ops. */
export interface ArchitectureRestructurePlanCandidate {
  /** Unique within the request; never prefixed `report:` (the report's own candidates own that prefix). */
  id: string;
  rationale?: string;
  ops: ArchitectureRestructureOp[];
}

/** Per impact tier, the violations a delta resolved and introduced. An untiered violation counts as `structural`. */
export type ArchitectureRestructureTierTally = Record<
  ArchitectureViolationImpactTier,
  { resolved: number; introduced: number }
>;

/** A restructure delta with its per-tier tally — the plan's objective reads `byTier`. */
export interface ArchitectureRestructurePlanDelta extends ArchitectureRestructureDelta {
  byTier: ArchitectureRestructureTierTally;
}

/** Where a plan candidate came from: the request, or the base report's split/merge verdicts. */
export type ArchitectureRestructurePlanCandidateSource = "caller" | "report";

/** One selected step, in plan order. */
export interface ArchitectureRestructurePlanStep {
  candidateId: string;
  source: ArchitectureRestructurePlanCandidateSource;
  rationale?: string;
  ops: ArchitectureRestructureCompiledOp[];
  /** Versus the prefix before this step, not versus the base. */
  delta: ArchitectureRestructurePlanDelta;
  /** Base paths the ops name, code-point sorted. */
  touchedFiles: string[];
  /** Σ codegraph transitiveImpact of touchedFiles; a file with no reading (an added file) adds 0. */
  blastRadius: number;
}

/** A candidate that introduces a critical or active violation — reported, never selected. */
export interface ArchitectureRestructurePlanTradeOff {
  candidateId: string;
  source: ArchitectureRestructurePlanCandidateSource;
  rationale?: string;
  /** Versus the prefix it was judged against. */
  delta: ArchitectureRestructurePlanDelta;
}

/** A candidate the plan left out: nothing gained over the final prefix, or its ops no longer compile on it. */
export interface ArchitectureRestructurePlanUnselected {
  candidateId: string;
  source: ArchitectureRestructurePlanCandidateSource;
  reason: "noImprovement" | "conflictsWithPrefix";
  /** The compile failure, for `conflictsWithPrefix`. */
  detail?: string;
}

/** `get_architecture_report` in restructurePlan mode — the ordered steps and what was left out. */
export interface GetArchitectureRestructurePlanResponse {
  workingTree?: WorkingTreeMarker;
  mode: "restructurePlan";
  steps: ArchitectureRestructurePlanStep[];
  tradeOffs: ArchitectureRestructurePlanTradeOff[];
  unselected: ArchitectureRestructurePlanUnselected[];
  /** Base vs the final prefix. */
  total: ArchitectureRestructurePlanDelta;
  /** `judgeCount` counts every full detector run, the base included. */
  timing: { factsMs: number; judgeCount: number; totalMs: number };
  /** No codegraph database to judge — nothing was planned. */
  unavailable?: "noCodegraph";
}

/** Max `GetArchitectureReportRequest.plannedEdges` per call. */
export const ARCHITECTURE_PLANNED_EDGE_LIMIT = 50;

/** One edge a writer is about to add: `source` will import / call `target`. */
export interface ArchitecturePlannedEdge {
  /** Repo-relative path of the file that will depend. */
  source: string;
  /** Repo-relative path of the file it will depend on. */
  target: string;
  /**
   * The name `source` will reference `target` by (`Outer::Inner`) — lets the
   * constant-reference exclusion run; absent, it is listed as unchecked.
   */
  reference?: string;
}

/**
 * CONFORMS = along a direction the project writes; MISFIT = against its role
 * pair's established direction; NEW_PATTERN = a direction nobody wrote whose
 * pair has no established direction; UNJUDGED = no verdict, see `reason`.
 */
export type ArchitecturePlannedEdgeVerdictKind = "CONFORMS" | "MISFIT" | "NEW_PATTERN" | "UNJUDGED";

export type ArchitecturePlannedEdgeUnjudgedReason =
  | "newFile"
  | "nonProduction"
  | "untypedFile"
  | "weakRole"
  | "crossLanguage"
  | "inheritance"
  | "constantReference"
  | "displacedRole"
  | "noCodegraph";

/** The route the project establishes instead of the planned edge. */
export interface ArchitecturePlannedEdgeExpectedPath {
  /** MISFIT: the direction the project established for the pair, with its edge count. */
  established?: { roleSrc: string; roleDst: string; support: number };
  /** An established route through a third role: roles = [roleSrc, via, roleDst], one support per leg. */
  transit?: { roles: [string, string, string]; supportIn: number; supportOut: number };
}

export interface ArchitecturePlannedEdgeVerdict {
  source: string;
  target: string;
  verdict: ArchitecturePlannedEdgeVerdictKind;
  roleSrc?: string;
  roleDst?: string;
  /** The language family whose ledger judged the edge. */
  family?: string;
  locality?: "sameDirectory" | "sameDomain" | "crossDomain";
  /** Edges roleSrc → roleDst the ledger holds. */
  pairSupport?: number;
  /** Edges roleDst → roleSrc the ledger holds. */
  reverseSupport?: number;
  /** The pair's two-sided sign-test p (BH-gated in the ledger). */
  pValue?: number;
  expectedPath?: ArchitecturePlannedEdgeExpectedPath;
  /** UNJUDGED only. */
  reason?: ArchitecturePlannedEdgeUnjudgedReason;
  /** `reason: "weakRole"` only: the endpoint whose role is weak, the other is strong. */
  weakSide?: "source" | "target" | "both";
  /** Exclusion classes a planned edge's evidence cannot evaluate — present with a verdict. */
  exclusionsUnchecked?: ("constantReference" | "uncalled" | "frameworkRouted")[];
}

/** `get_architecture_report` in planned-edges mode — the verdicts and nothing else. */
export interface GetArchitecturePlannedEdgesResponse {
  workingTree?: WorkingTreeMarker;
  mode: "plannedEdges";
  /** The report's detector families are not run in this mode — call without plannedEdges for the report. */
  detectorFamilies: "notRun";
  plannedEdgeVerdicts: ArchitecturePlannedEdgeVerdict[];
}
