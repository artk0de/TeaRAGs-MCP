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
  ArchitectureRestructureCompiledOp,
  ArchitectureRestructureOp,
} from "../../../contracts/types/architecture-report.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";
import type { ArchitectureChangeSubject } from "./review.js";

export type * from "../../../contracts/types/architecture-report.js";

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
  /** Page start for the `knotOf` view (default 0). */
  offset?: number;
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
