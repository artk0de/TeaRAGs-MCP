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

import type { ArchitectureLayerMapOptions } from "../../../contracts/types/architecture-report.js";

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
}
