/**
 * Finding-shaping helpers two or more `DiffFamilyDetector` modules share —
 * the rendered subject, the status row, the report's three-decimal evidence
 * formatting and the `preExisting` wording.
 */

import {
  renderDiffFindingSubject,
  type DiffDetectorFamily,
  type DiffDetectorFinding,
  type DiffDetectorStatus,
  type DiffFindingEndpoints,
} from "../../../../contracts/types/diff-detector-finding.js";
import type { HeldBeforeChangeEvidence } from "./diff-family-detector.js";

/** A finding draft: everything but the subject, which is rendered from the endpoints. */
type DiffDetectorFindingDraft = DiffDetectorFinding extends infer Finding
  ? Finding extends { endpoints: DiffFindingEndpoints }
    ? Omit<Finding, "subject">
    : never
  : never;

/** A finding whose `subject` is rendered from its endpoints — never authored beside them (bd tea-rags-mcp-r8hme.44). */
export function withRenderedSubject(draft: DiffDetectorFindingDraft): DiffDetectorFinding {
  // Key order detector, subject, endpoints, … — the reading order the finding had before endpoints existed.
  return Object.assign({ detector: draft.detector, subject: renderDiffFindingSubject(draft.endpoints) }, draft);
}

/**
 * The whole-module import name, re-exported for the diff families: an import
 * taking it takes whatever the surface holds — no single name drop breaks it,
 * and no named retarget can carry it.
 */
export { WHOLE_MODULE_EXPORT_NAME } from "../../../../contracts/types/codegraph.js";

export const HELD_BY_WORDING: Readonly<Record<HeldBeforeChangeEvidence, string>> = {
  base: "the diff base already holds it",
  index: "the indexed graph already holds it",
};

export const HELD_IN_WORDING: Readonly<Record<HeldBeforeChangeEvidence, string>> = {
  base: "at the diff base",
  index: "in the index",
};

/** A built detector family's verdict row. */
export function detectorStatus(detector: DiffDetectorFamily, findingCount: number): DiffDetectorStatus {
  return Object.freeze({ detector, built: true, findingCount });
}

/** Three decimals — the whole-repo report's evidence formatting. */
export function format3(value: number): string {
  return value.toFixed(3);
}

/** Three decimals as a number — the precision structured evidence carries, the report's `round3`. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
