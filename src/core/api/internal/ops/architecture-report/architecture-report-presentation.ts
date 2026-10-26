/**
 * The `get_architecture_report` TOOL view (bd tea-rags-mcp-9ah49).
 *
 * The flat internal report is one union column table at the tool boundary —
 * every detector's columns on every row, mostly null — and its evidence arrays
 * dwarf the findings. This view groups violations per detector (each group
 * tabulates with only its own columns), caps every evidence array, lifts a
 * group-wide drill-down hint out of the rows, reduces the explained pairs to a
 * count, and answers one `next` call per group whose evidence it cut. The
 * summary's blocks and the root causes get the same cap (bd
 * tea-rags-mcp-q1g6s.1); the `detectors` selector scopes the detector-owned
 * summary blocks and root causes with the groups.
 *
 * Pure: the internal {@link GetArchitectureReportResponse} is never mutated —
 * review_changes, restructure and the violation delta read it flat.
 */

import type { SuggestedToolCall } from "../../../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../../../contracts/types/working-tree.js";
import { toolCallAddressFromWorkingTree } from "../../../../domains/explore/index.js";
import {
  ARCHITECTURE_REPORT_DETECTORS,
  ARCHITECTURE_REPORT_EVIDENCE_LIMIT,
  type ArchitectureReportDetector,
  type ArchitectureReportEvidenceLimit,
  type ArchitectureViolation,
  type GetArchitectureReportRequest,
  type GetArchitectureReportResponse,
  type GetArchitectureReportToolResponse,
} from "../../../public/dto/architecture.js";

/** How the tool presents one judged report — the request's view params, resolved. */
export interface ArchitectureReportView {
  evidenceLimit: ArchitectureReportEvidenceLimit;
  detectors?: readonly ArchitectureReportDetector[];
  includeExplainedPairs: boolean;
  /** The judged report's snapshot id, when one is cached — carried into `next`. */
  reportId?: string;
  /** The request's judging params a `next` call repeats (address and view params excluded). */
  judgingArgs: Record<string, unknown>;
}

/** Request keys that address the index — `next` takes the answering tree's address instead. */
const ADDRESS_KEYS = new Set(["project", "collection", "path"]);
/** Request keys that only shape the view — a drill-down sets its own. */
const VIEW_KEYS = new Set(["evidenceLimit", "detectors", "includeExplainedPairs"]);
/** Evidence objects that are a ready call's arguments — cutting one would make the call lie. */
const CALL_ARGUMENT_KEYS = new Set(["drillDown"]);
/** Summary blocks a detector owns — scoped by `detectors`, drilled through it; the rest are graph-wide. */
const DETECTOR_KEYS: ReadonlySet<string> = new Set(ARCHITECTURE_REPORT_DETECTORS);
/** Summary blocks kept whole: `impactTiers.notApplicable.detectors` is a detector set, not evidence. */
const WHOLE_SUMMARY_KEYS = new Set(["impactTiers"]);

export function architectureReportViewOf(
  request: GetArchitectureReportRequest,
  reportId?: string,
): ArchitectureReportView {
  const judgingArgs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined && !ADDRESS_KEYS.has(key) && !VIEW_KEYS.has(key)) judgingArgs[key] = value;
  }
  return {
    evidenceLimit: request.evidenceLimit ?? ARCHITECTURE_REPORT_EVIDENCE_LIMIT,
    ...(request.detectors ? { detectors: request.detectors } : {}),
    includeExplainedPairs: request.includeExplainedPairs === true,
    ...(reportId !== undefined ? { reportId } : {}),
    judgingArgs,
  };
}

export function presentArchitectureReport(
  report: GetArchitectureReportResponse,
  view: ArchitectureReportView,
  marker: WorkingTreeMarker | undefined,
): GetArchitectureReportToolResponse {
  const { violations, summary, rootCauses, ...rest } = report;
  const limit = view.evidenceLimit === "all" ? undefined : view.evidenceLimit;
  const selected = (detector: string): boolean =>
    !view.detectors || view.detectors.includes(detector as ArchitectureReportDetector);
  const groups: Partial<Record<ArchitectureReportDetector, ArchitectureViolation[]>> = {};
  const hints: Partial<Record<ArchitectureReportDetector, string>> = {};
  const trimmedDetectors = new Set<ArchitectureReportDetector>();

  for (const [detector, rows] of groupByDetector(violations)) {
    if (!selected(detector)) continue;
    let trimmed = false;
    const presented = rows.map((violation) => {
      const { detector: _key, ...row } = violation as ArchitectureViolation & Record<string, unknown>;
      if (limit === undefined) return row;
      const cut = trimEvidence(row, limit, true);
      trimmed ||= cut.trimmed;
      return cut.value as Record<string, unknown>;
    });
    const hint = sharedDrillDownHint(presented);
    if (hint !== undefined) {
      hints[detector] = hint;
      presented.forEach(dropDrillDownHint);
    }
    groups[detector] = presented as unknown as ArchitectureViolation[];
    if (trimmed) trimmedDetectors.add(detector);
  }

  const presentedRootCauses = rootCauses
    .filter((rootCause) => selected(rootCause.detector))
    .map((rootCause) => {
      if (limit === undefined) return rootCause;
      const cut = trimEvidence(rootCause, limit, true);
      if (cut.trimmed) trimmedDetectors.add(rootCause.detector);
      return cut.value as typeof rootCause;
    });

  const { explainedPairs, ...silentCoupling } = summary.silentCoupling;
  const blocks: Record<string, unknown> = {
    ...summary,
    silentCoupling: {
      ...silentCoupling,
      // The total, not the limit-capped list's length (bd tea-rags-mcp-jur12).
      explainedPairCount: silentCoupling.excluded.explainedBySharedNeighbour,
    },
  };
  const presentedSummary: Record<string, unknown> = {};
  const trimmedSummaryKeys: string[] = [];
  for (const [key, block] of Object.entries(blocks)) {
    const ownedByDetector = DETECTOR_KEYS.has(key);
    if (ownedByDetector && !selected(key)) continue;
    if (limit === undefined || WHOLE_SUMMARY_KEYS.has(key)) {
      presentedSummary[key] = block;
      continue;
    }
    const cut = trimEvidence(block, limit, false);
    presentedSummary[key] = cut.value;
    if (!cut.trimmed) continue;
    if (ownedByDetector) trimmedDetectors.add(key as ArchitectureReportDetector);
    else trimmedSummaryKeys.push(key);
  }
  // The opt-in list rides whole: the caller asked for it, and it is capped at `limit` upstream.
  if (view.includeExplainedPairs && explainedPairs && presentedSummary.silentCoupling) {
    presentedSummary.silentCoupling = { ...presentedSummary.silentCoupling, explainedPairs };
  }

  const next = [...trimmedDetectors].map((detector) =>
    drillDownCall(view, marker, `the ${detector} group with every evidence entry`, detector),
  );
  // Graph-wide summary blocks belong to no detector, so their drill-down is the unscoped call.
  if (trimmedSummaryKeys.length > 0) {
    next.push(drillDownCall(view, marker, `summary ${trimmedSummaryKeys.join(", ")} with every entry`));
  }
  return {
    ...rest,
    rootCauses: presentedRootCauses,
    summary: presentedSummary as unknown as GetArchitectureReportToolResponse["summary"],
    violations: groups,
    ...(Object.keys(hints).length > 0 ? { violationDrillDownHints: hints } : {}),
    ...(limit !== undefined && next.length > 0 ? { evidenceTrimmed: { limit } } : {}),
    ...(next.length > 0 ? { next } : {}),
  };
}

/** Groups in first-appearance order — the report already lists detectors in its order. */
function groupByDetector(
  violations: readonly ArchitectureViolation[],
): Map<ArchitectureReportDetector, ArchitectureViolation[]> {
  const groups = new Map<ArchitectureReportDetector, ArchitectureViolation[]>();
  for (const violation of violations) {
    const group = groups.get(violation.detector);
    if (group) group.push(violation);
    else groups.set(violation.detector, [violation]);
  }
  return groups;
}

/**
 * Caps every array nested under the row's object fields at `limit` — by shape,
 * not by name. The row's own top-level arrays (a finding's subject:
 * `partners`, `components`) and call arguments stay whole. A cut array gains a
 * sibling `<key>Count` with its full length unless the object already counts
 * it (`<key>Count` or the singular `fileEdgeCount` form).
 */
function trimEvidence(value: unknown, limit: number, isRow: boolean): { value: unknown; trimmed: boolean } {
  if (Array.isArray(value)) {
    let trimmed = false;
    const items = value.slice(0, limit).map((item) => {
      const cut = trimEvidence(item, limit, false);
      trimmed ||= cut.trimmed;
      return cut.value;
    });
    return { value: items, trimmed: trimmed || value.length > limit };
  }
  if (value === null || typeof value !== "object") return { value, trimmed: false };
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let trimmed = false;
  for (const [key, field] of Object.entries(source)) {
    if (CALL_ARGUMENT_KEYS.has(key) || (isRow && Array.isArray(field))) {
      out[key] = field;
      continue;
    }
    const cut = trimEvidence(field, limit, false);
    out[key] = cut.value;
    trimmed ||= cut.trimmed;
    if (Array.isArray(field) && field.length > limit && !countsLength(source, key)) out[`${key}Count`] = field.length;
  }
  return { value: out, trimmed };
}

function countsLength(owner: Record<string, unknown>, key: string): boolean {
  return `${key}Count` in owner || (key.endsWith("s") && `${key.slice(0, -1)}Count` in owner);
}

function drillDownOf(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const evidence = row.evidence as Record<string, unknown> | undefined;
  const drillDown = evidence?.drillDown;
  return drillDown !== null && typeof drillDown === "object" ? (drillDown as Record<string, unknown>) : undefined;
}

/**
 * The hint every drill-down of the group carries, identical; undefined when a
 * drill-down lacks it or they differ. Rows with no drill-down at all (a
 * silent-coupling pair beside the grouped findings) do not veto the hoist.
 */
function sharedDrillDownHint(rows: readonly Record<string, unknown>[]): string | undefined {
  const hints = rows.flatMap((row) => {
    const drillDown = drillDownOf(row);
    return drillDown ? [drillDown.hint] : [];
  });
  const [first] = hints;
  return typeof first === "string" && hints.every((hint) => hint === first) ? first : undefined;
}

/** Rows are the view's own copies (spread above), so the drill-down object is copied before the hint goes. */
function dropDrillDownHint(row: Record<string, unknown>): void {
  const found = drillDownOf(row);
  if (!found) return;
  const { hint: _hint, ...drillDown } = found;
  row.evidence = { ...(row.evidence as Record<string, unknown>), drillDown };
}

/** The same call with `evidenceLimit: "all"`, narrowed to `detector` when one owns the cut part. */
function drillDownCall(
  view: ArchitectureReportView,
  marker: WorkingTreeMarker | undefined,
  why: string,
  detector?: ArchitectureReportDetector,
): SuggestedToolCall {
  return {
    tool: "get_architecture_report",
    args: {
      ...toolCallAddressFromWorkingTree(marker),
      ...view.judgingArgs,
      ...(view.reportId !== undefined ? { reportId: view.reportId } : {}),
      ...(detector !== undefined ? { detectors: [detector] } : {}),
      evidenceLimit: "all",
    },
    why,
  };
}
