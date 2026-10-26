/**
 * The `get_architecture_report` TOOL view (bd tea-rags-mcp-9ah49).
 *
 * The flat internal report is one union column table at the tool boundary —
 * every detector's columns on every row, mostly null — and its evidence arrays
 * dwarf the findings. This view groups violations per detector (each group
 * tabulates with only its own columns), caps every evidence array, lifts a
 * group-wide drill-down hint out of the rows, reduces the explained pairs to a
 * count, and answers one `next` call per group whose evidence it cut.
 *
 * Pure: the internal {@link GetArchitectureReportResponse} is never mutated —
 * review_changes, restructure and the violation delta read it flat.
 */

import type { SuggestedToolCall } from "../../../../contracts/types/suggested-tool-call.js";
import type { WorkingTreeMarker } from "../../../../contracts/types/working-tree.js";
import { toolCallAddressFromWorkingTree } from "../../../../domains/explore/index.js";
import {
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
  const { violations, summary, ...rest } = report;
  const limit = view.evidenceLimit === "all" ? undefined : view.evidenceLimit;
  const groups: Partial<Record<ArchitectureReportDetector, ArchitectureViolation[]>> = {};
  const hints: Partial<Record<ArchitectureReportDetector, string>> = {};
  const trimmedDetectors: ArchitectureReportDetector[] = [];

  for (const [detector, rows] of groupByDetector(violations)) {
    if (view.detectors && !view.detectors.includes(detector)) continue;
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
    if (trimmed) trimmedDetectors.push(detector);
  }

  const { explainedPairs, ...silentCoupling } = summary.silentCoupling;
  const next = trimmedDetectors.map((detector) => drillDownCall(detector, view, marker));
  return {
    ...rest,
    summary: {
      ...summary,
      silentCoupling: {
        ...silentCoupling,
        // The total, not the limit-capped list's length (bd tea-rags-mcp-jur12).
        explainedPairCount: silentCoupling.excluded.explainedBySharedNeighbour,
        ...(view.includeExplainedPairs && explainedPairs ? { explainedPairs } : {}),
      },
    },
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

/** The hint every row of the group carries, identical; undefined when any row lacks it or differs. */
function sharedDrillDownHint(rows: readonly Record<string, unknown>[]): string | undefined {
  const hints = rows.map((row) => drillDownOf(row)?.hint);
  const [first] = hints;
  return typeof first === "string" && hints.every((hint) => hint === first) ? first : undefined;
}

/** Rows are the view's own copies (spread above), so the drill-down object is copied before the hint goes. */
function dropDrillDownHint(row: Record<string, unknown>): void {
  const evidence = row.evidence as Record<string, unknown>;
  const { hint: _hint, ...drillDown } = drillDownOf(row) ?? {};
  row.evidence = { ...evidence, drillDown };
}

function drillDownCall(
  detector: ArchitectureReportDetector,
  view: ArchitectureReportView,
  marker: WorkingTreeMarker | undefined,
): SuggestedToolCall {
  return {
    tool: "get_architecture_report",
    args: {
      ...toolCallAddressFromWorkingTree(marker),
      ...view.judgingArgs,
      ...(view.reportId !== undefined ? { reportId: view.reportId } : {}),
      detectors: [detector],
      evidenceLimit: "all",
    },
    why: `the ${detector} group with every evidence entry`,
  };
}
