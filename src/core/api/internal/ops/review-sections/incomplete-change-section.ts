/**
 * The `incompleteChange` review section (bd tea-rags-mcp-89k7k.1.4; the review
 * half of bd tea-rags-mcp-3kykc): a co-change partner of a diff file that the
 * diff does NOT touch is the finding — history says the two change together,
 * this change carries only one side. A partner the diff ALSO touches is not a
 * finding (the change carries the pair); a pair neither side of which is in
 * the diff is not this review's business.
 *
 * The co-change significance gate (bd tea-rags-mcp-89k7k.1.14) admits a pair
 * first: its support, counted over the history MINUS the bundles the diff's own
 * commits formed (`scope.diffCommits` — the change must not confirm itself),
 * beats the configuration null that conditions on both files' change counts,
 * under BH over the query family of every pair touching the diff
 * ({@link assessGraphCochangeSignificance}). A version manifest or locale file
 * that co-changes with everything has the change count to explain it, so its
 * pairs die here. Without bundle membership in the read, lift above 1 admits.
 *
 * The coupling-statistics gate (bd tea-rags-mcp-89k7k.1.12): raw support
 * ranked noise first — measured 2026-10-05 on an 8-file diff, 234 findings
 * dominated by a hub contracts file and a generated version-pins artefact. A
 * finding must now clear the SAME machinery the whole-repo silent-coupling
 * detector applies, imported from where it lives, never duplicated: lift above
 * 1 (the pair beats chance), strength = {@link cochangeStrength} (the larger
 * direction's Wilson lower bound — a hub diluted across its own huge change
 * count reads weak in both directions), and the majority-floored Otsu cut
 * over the corpus's candidate strengths
 * ({@link resolveMajorityFlooredOtsuThreshold}; the r8hme.46 separability
 * gate may resolve the cut to the majority floor — `method` is consumed
 * honestly in the payload). The cut's population mirrors this section's own
 * candidacy (lift above 1, neither endpoint generated) rather than
 * silent-coupling's test-excluding one, because a missing test update is a
 * first-class finding here, not an exclusion: partner KIND tiers the ranking
 * — test first, source on its evidence, documentation last — while a
 * generated artefact (`version-pins.json` shapes) is excluded as a partner
 * outright, on either side of the pair.
 *
 * Relevance to the CHANGED CODE ranks within a tier: a partner the structural
 * graph links to the diff file (`structurallyLinked` — an import/call/
 * re-export edge in either direction) sorts above one that only co-changed
 * historically. That is the file-granular codegraph fact the stored edge
 * already carries; changed-SYMBOL-to-partner edges do not exist in the diff
 * run's plumbing, and this bead does not build them — the noted gap, not a
 * hidden one.
 *
 * Read: the wholesale temporal co-change snapshot
 * (`GraphDbClient#readTemporalCochangeGraph`) the whole-repo
 * `get_architecture_report`'s silent-coupling detector reads, filtered in
 * memory — 200-file diffs × ≤20 partners each is small, and per-file reads of
 * an undirected pair table would answer half the question. The build context
 * receives it pre-read (`temporalCochange`), so `isBuilt` stays a pure
 * decision. The reader's file cap limits the SOURCES: only a scanned file's
 * partners are considered, and a scope the cap truncated stamps the envelope
 * `scopeSkippedFiles` (bd tea-rags-mcp-89k7k.7) — a past-cap file's own
 * missing partners are never looked for, so the findings are partial, never a
 * clean pass. Whether a partner is MISSING is asked of the whole change
 * (`scope.touchedFiles`, bd tea-rags-mcp-lxbrr): a partner the change touches
 * past the cap, or deletes, is carried by the change and never a finding —
 * live, 23 of 29 reported partners were such files.
 */

import type { RelPath } from "../../../../contracts/types/codegraph.js";
import {
  assessGraphCochangeSignificance,
  cochangeStrength,
  SILENT_COUPLING_OTSU_MIN_POPULATION,
  SILENT_COUPLING_STRENGTH_MAJORITY,
} from "../../../../domains/trajectory/codegraph/temporal/index.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../primitives/graph/index.js";
import { classify } from "../../../../primitives/paths/index.js";
import type { IncompleteChangePartner, IncompleteChangePartnerKind } from "../../../public/dto/review.js";
import { isDocumentationPath } from "../architecture-report-ops.js";
import type { ReviewSectionProvider } from "./review-section-provider.js";

/** Findings the section lists; the rest are counted in `truncated`. */
const PARTNER_CAP = 50;

/** The finding tiers, strongest signal first — a missing test update leads. */
const KIND_TIER: Readonly<Record<IncompleteChangePartnerKind, number>> = {
  test: 0,
  source: 1,
  documentation: 2,
};

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
    // is not a source, so its own missing partners are unjudged below.
    const truncatedScope = scope.skipped > 0 ? { scopeSkippedFiles: scope.skipped } : {};
    const graph = context.temporalCochange;
    if (graph === undefined || graph === null) return { partners: [], ...truncatedScope };
    // Sources are the scanned (capped) files; presence is the whole change.
    const isSource = new Set(scope.files);
    const inChange = scope.touchedFiles;
    const isGenerated = generatedPathMemo();
    // The cut is drawn over the CORPUS's candidates — every stored pair that
    // could ever be a finding here — not the diff's slice of them, so the
    // threshold is stable from review to review of one collection.
    const policy = resolveMajorityFlooredOtsuThreshold(
      graph.edges
        .filter((edge) => edge.lift > 1 && !isGenerated(edge.relPathA) && !isGenerated(edge.relPathB))
        .map((edge) => cochangeStrength(edge)),
      { majority: SILENT_COUPLING_STRENGTH_MAJORITY, minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION },
    );

    const significance = assessGraphCochangeSignificance(graph, {
      kind: "query",
      diffFiles: scope.files,
      ...(scope.diffCommits ? { diffCommits: scope.diffCommits } : {}),
    });
    let notSignificant = 0;

    const findings: IncompleteChangePartner[] = [];
    for (const edge of graph.edges) {
      // A scanned file whose partner the change does not touch is the only
      // finding shape: both in the change = the change carries the pair; no
      // scanned side = not a question this (capped) read asks.
      const aSource = isSource.has(edge.relPathA) && !inChange.has(edge.relPathB);
      const bSource = isSource.has(edge.relPathB) && !inChange.has(edge.relPathA);
      if (!aSource && !bSource) continue;
      const [file, missingPartner, confidence] = aSource
        ? [edge.relPathA, edge.relPathB, edge.confidenceAB]
        : [edge.relPathB, edge.relPathA, edge.confidenceBA];
      // A generated artefact on either side is release noise, not a missing update.
      if (isGenerated(file) || isGenerated(missingPartner)) continue;
      // Pairs the history explains by the two files' change counts are not
      // findings: the hub's raw support dies here, before the Wilson floor.
      if (!(significance ? significance.admits(file, missingPartner) : edge.lift > 1)) {
        notSignificant++;
        continue;
      }
      const strength = cochangeStrength(edge);
      if (!policy.admits(strength)) continue;
      findings.push({
        file,
        missingPartner,
        partnerKind: partnerKindOf(missingPartner),
        support: edge.support,
        confidence,
        strength,
        lift: edge.lift,
        structurallyLinked: edge.structurallyLinked,
        lastCoChangeAt: edge.lastCoChangeAt,
      });
    }
    findings.sort(compareFindings);
    const partners = findings.slice(0, PARTNER_CAP);
    return {
      partners,
      strengthThreshold: policy.threshold,
      strengthThresholdMethod: policy.method,
      ...(policy.separability === undefined ? {} : { strengthSeparability: policy.separability }),
      ...(significance ? { cochangeSignificance: significance.summary, notSignificant } : {}),
      ...truncatedScope,
      ...(findings.length > partners.length ? { truncated: findings.length - partners.length } : {}),
    };
  },
};

/** The partner's tier: a test is the first-class signal, documentation trails. */
function partnerKindOf(relPath: RelPath): IncompleteChangePartnerKind {
  if (classify(relPath).isTest) return "test";
  if (isDocumentationPath(relPath)) return "documentation";
  return "source";
}

/** `classify` per distinct path, once — the corpus graph repeats endpoints. */
function generatedPathMemo(): (relPath: RelPath) => boolean {
  const memo = new Map<RelPath, boolean>();
  return (relPath) => {
    const cached = memo.get(relPath);
    if (cached !== undefined) return cached;
    const verdict = classify(relPath).isGenerated;
    memo.set(relPath, verdict);
    return verdict;
  };
}

/**
 * Kind tier first (the missing test update leads), then code-level relevance
 * (a structurally linked partner above a history-only one), then the
 * statistical evidence strongest first; paths break the ties, so the order is
 * the same on every machine.
 */
function compareFindings(x: IncompleteChangePartner, y: IncompleteChangePartner): number {
  return (
    KIND_TIER[x.partnerKind] - KIND_TIER[y.partnerKind] ||
    Number(y.structurallyLinked) - Number(x.structurallyLinked) ||
    y.strength - x.strength ||
    y.support - x.support ||
    y.confidence - x.confidence ||
    comparePaths(x.file, y.file) ||
    comparePaths(x.missingPartner, y.missingPartner)
  );
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
