/**
 * The `incompleteChange` review section (bd tea-rags-mcp-89k7k.1.4; the review
 * half of bd tea-rags-mcp-3kykc): a co-change partner of a diff file that the
 * diff does NOT touch is the finding — history says the two change together,
 * this change carries only one side. A partner the diff ALSO touches is not a
 * finding (the change carries the pair); a pair neither side of which is in
 * the diff is not this review's business.
 *
 * Read: the wholesale temporal co-change snapshot
 * (`GraphDbClient#readTemporalCochangeGraph`) the whole-repo
 * `get_architecture_report`'s silent-coupling detector reads, filtered in
 * memory — 200-file diffs × ≤20 partners each is small, and per-file reads of
 * an undirected pair table would answer half the question. The build context
 * receives it pre-read (`temporalCochange`), so `isBuilt` stays a pure
 * decision. A scope the reader's file cap truncated stamps the envelope
 * `scopeSkippedFiles` (bd tea-rags-mcp-89k7k.7): a past-cap file is not in
 * the diff set, so neither side of its pairs reads as "in the diff" and its
 * missing partners are never considered — the findings are partial, never a
 * clean pass.
 */

import type { IncompleteChangePartner } from "../../../public/dto/review.js";
import type { ReviewSectionProvider } from "./review-section-provider.js";

/** Findings the section lists; the rest are counted in `truncated`. */
const PARTNER_CAP = 50;

export const incompleteChangeSectionProvider: ReviewSectionProvider = {
  id: "incompleteChange",
  consumesTemporalCochange: true,

  isBuilt: (context) => {
    if (context.graphDb === undefined) {
      return { built: false, reason: "codegraph database unavailable for the addressed collection" };
    }
    if (context.temporalCochangeError !== undefined) {
      return { built: false, reason: `temporal co-change graph unreadable: ${context.temporalCochangeError}` };
    }
    if (context.temporalCochange === undefined) {
      return { built: false, reason: "temporal co-change graph not read for this review" };
    }
    if (context.temporalCochange === null) {
      return { built: false, reason: "no co-change build for this collection — run a codegraph enrichment" };
    }
    return { built: true };
  },

  run: async (context) => {
    const { scope } = context;
    // The never-a-clean-pass stamp (bd tea-rags-mcp-89k7k.7): a past-cap file
    // is not in the diff set, so its pairs are silently unjudged below.
    const truncatedScope = scope.skipped > 0 ? { scopeSkippedFiles: scope.skipped } : {};
    const graph = context.temporalCochange;
    if (graph === undefined || graph === null) return { partners: [], ...truncatedScope };
    const inDiff = new Set(scope.files);
    const findings: IncompleteChangePartner[] = [];
    for (const edge of graph.edges) {
      const aIn = inDiff.has(edge.relPathA);
      const bIn = inDiff.has(edge.relPathB);
      // Both in the diff = the change carries the pair; neither = not this review's business.
      if (aIn === bIn) continue;
      findings.push(
        aIn
          ? partnerFinding(edge.relPathA, edge.relPathB, edge.confidenceAB, edge)
          : partnerFinding(edge.relPathB, edge.relPathA, edge.confidenceBA, edge),
      );
    }
    findings.sort(
      (x, y) =>
        y.support - x.support ||
        y.confidence - x.confidence ||
        comparePaths(x.file, y.file) ||
        comparePaths(x.missingPartner, y.missingPartner),
    );
    const partners = findings.slice(0, PARTNER_CAP);
    return {
      partners,
      ...truncatedScope,
      ...(findings.length > partners.length ? { truncated: findings.length - partners.length } : {}),
    };
  },
};

/** The finding for one side of an edge: the confidence of the direction the reader acts on. */
function partnerFinding(
  file: string,
  missingPartner: string,
  confidence: number,
  edge: { support: number; lastCoChangeAt: number },
): IncompleteChangePartner {
  return { file, missingPartner, support: edge.support, confidence, lastCoChangeAt: edge.lastCoChangeAt };
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
