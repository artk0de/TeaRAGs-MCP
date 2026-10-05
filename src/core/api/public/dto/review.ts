/**
 * review_changes DTO (bd tea-rags-mcp-89k7k.1.4, F3) — every diff-scoped
 * report over ONE working-tree change, in one call. The request names the
 * change exactly as `get_naming_lexicon`'s diff mode does (the F0 reader's
 * contract: worktree addressing, merge-base semantics, the file cap); the
 * response is one envelope plus a section map keyed by section id.
 *
 * Two different absences, two different signals (owner-confirmed 2026-10-01):
 * a section NOT in the request is OMITTED from the map — absence is not
 * not-built; a section IN the request whose substrate is missing appears with
 * `built: false` and its reason. An unknown section id fails loud at the
 * boundary (the enum is derived from the live provider registry), so an agent
 * asking for a section never has to guess whether it ran.
 */

import type { TemporalCohesionReport } from "../../../domains/trajectory/codegraph/temporal/index.js";
import type { DiffDetectorFinding, DiffDetectorStatus } from "../../internal/ops/diff-detector-run.js";
import type { CollectionRef } from "./explore.js";
import type { NamingReviewResult } from "./naming-lexicon.js";
import type { WorkingTreeMarker } from "./working-tree.js";

/**
 * Section ids the review knows. The MCP enum is NOT this union — it is derived
 * from the live provider registry (`reviewSectionIds`) — so the two lists stay
 * in step by construction, not by hand.
 */
export type ReviewSectionId = "naming" | "incompleteChange" | "cohesion" | "architecture";

/** The change to review: the base to diff against, or an explicit list of files. */
export interface ReviewChangesRequest extends CollectionRef {
  /**
   * Review the working tree's change (spec §6): `base` resolved to its
   * merge-base with HEAD — what THIS branch changed — untracked files
   * included. Default `HEAD` (uncommitted work).
   */
  changes?: { base?: string };
  /** Review these files only, against `changes.base` the same way; a listed file with no diff is reviewed whole. */
  files?: string[];
  /**
   * ALLOWLIST of section ids, default every registered section. Allowlist
   * only — no exclude form; "all but X" is spelled out. Unknown id = error.
   */
  sections?: ReviewSectionId[];
}

/** One file a section did not judge, and why — absence, never a zero. */
export interface ReviewSectionNotJudgedEntry {
  relPath: string;
  reason: string;
  detail?: string;
}

/** The uniform envelope every section result carries beside its own payload. */
export interface ReviewSectionEnvelope {
  built: boolean;
  /** When not built: the substrate that was missing or failed. */
  reason?: string;
  notJudged?: readonly ReviewSectionNotJudgedEntry[];
  /**
   * Changed files the diff's file cap skipped while this section judged (bd
   * tea-rags-mcp-89k7k.7) — the section-level form of
   * `DiffDetectorStatus.scopeSkippedFiles`, for the sections whose findings
   * are per-file or per-pair rows and cannot carry it. Present = the verdict
   * is PARTIAL: a truncated scope never yields a clean pass. Absent on a
   * not-built section — `built: false` + `reason` already denies the pass.
   */
  scopeSkippedFiles?: number;
}

/**
 * `naming` payload: the `get_naming_lexicon` diff review (`NamingReviewResult`)
 * verbatim — findings, checked, conforming, novel, notJudgedBy, notJudgedNames,
 * truncated — field parity for free until the lexicon endpoint's own diff mode
 * is removed after F4.
 */
export type NamingSectionResult = ReviewSectionEnvelope & NamingReviewResult;

/**
 * What the missing partner IS — the finding's tier, not its evidence (bd
 * tea-rags-mcp-89k7k.1.12). A missing TEST update is the first-class signal
 * (top tier); a documentation partner is a separate low tier; a generated
 * artefact is never a finding at all.
 */
export type IncompleteChangePartnerKind = "test" | "source" | "documentation";

/**
 * One incomplete-change finding (the review half of bd tea-rags-mcp-3kykc):
 * history says `file` and `missingPartner` change together; this diff touches
 * `file` and not the partner — the change may be missing its other half. The
 * finding has cleared the coupling-statistics gate (lift above chance, Wilson
 * strength above the corpus cut — bd tea-rags-mcp-89k7k.1.12): what raw
 * support used to surface is now only the evidence, never the ranking.
 */
export interface IncompleteChangePartner {
  file: string;
  missingPartner: string;
  /** {@link IncompleteChangePartnerKind} of `missingPartner`. */
  partnerKind: IncompleteChangePartnerKind;
  /** Admitted bundles that touched both files. */
  support: number;
  /** P(missingPartner changes | file changes). */
  confidence: number;
  /**
   * How sure the history is the pair moves together — the larger direction's
   * Wilson lower bound, the same `cochangeStrength` silent coupling ranks by.
   */
  strength: number;
  /** support·N/(changes(A)·changes(B)); above 1 = the pair beats chance. */
  lift: number;
  /**
   * The structural graph joins the two files (an import/call/re-export edge,
   * either direction) — the diff run's file-granular codegraph fact, ranking
   * the partner above one that only co-changed historically.
   */
  structurallyLinked: boolean;
  /** Unix seconds of the newest bundle that touched both. */
  lastCoChangeAt: number;
}

export interface IncompleteChangeSectionPayload {
  partners: readonly IncompleteChangePartner[];
  /**
   * The strength cut every listed finding cleared: Otsu's over the corpus's
   * candidate strengths when that population is bimodal enough, the strict
   * 0.5 majority floor otherwise — `strengthThresholdMethod` says which, so a
   * `majority` cut is read as the corpus refusing to draw one, not as 0.5
   * being special (bd tea-rags-mcp-r8hme.46's gate, consumed honestly).
   */
  strengthThreshold: number;
  strengthThresholdMethod: "otsu" | "majority";
  /** η of the Otsu cut — its evidence, or the rejection evidence under `majority`. */
  strengthSeparability?: number;
  /** Findings past the cap of 50 — counted, not listed. */
  truncated?: number;
}

export type IncompleteChangeSectionResult = ReviewSectionEnvelope & IncompleteChangeSectionPayload;

/**
 * `cohesion` payload: per changed file, the A3 behavioral-cohesion analysis
 * over the persisted per-symbol commit sets (S1, bd tea-rags-mcp-3gz4f) —
 * clusters, cohesion share, split candidates.
 */
export interface CohesionSectionPayload {
  reports: readonly TemporalCohesionReport[];
  /** Files whose read produced a report (counted before the cap). */
  analyzedFiles: number;
  /** Files with no report — listed in the envelope's `notJudged` as `noCohesionData`. */
  nullReports: number;
  /** Reports past the cap of 50 — counted, not listed. */
  truncated?: number;
}

export type CohesionSectionResult = ReviewSectionEnvelope & CohesionSectionPayload;

/**
 * `architecture` payload (bd tea-rags-mcp-89k7k.1.4, F3 slice 2): the diff's
 * edges judged by the detector run — findings in the whole-repo report's
 * detector kinds (plus `cycles`), per-family statuses with `splitCandidates`
 * honestly unbuilt until A5/c3v6o lands.
 */
export interface ArchitectureSectionPayload {
  /**
   * Detector findings over the diff's overlay edges, listed under the
   * family-aware cap of 100 (bd tea-rags-mcp-35v4v): every family keeps at
   * least one slot, and each family's cut is counted on its own detector row —
   * never silently dropped. `foundationTerminal` and `preExisting` ride these
   * rows (see {@link DiffDetectorFinding}).
   */
  findings: readonly DiffDetectorFinding[];
  /**
   * Per-detector verdict row — the `splitCandidates` family is `built: false`
   * until its substrate ships. Rows carry the family's own `truncated` count,
   * the `scopeSkippedFiles` partial marker, and the family's exclusion
   * counters; the per-field semantics live on {@link DiffDetectorStatus} —
   * this envelope does not restate them.
   */
  detectors: readonly DiffDetectorStatus[];
  /**
   * SECTION-level total past the cap of 100 — counted, not listed. The
   * per-family cuts live on the detector rows' `truncated` (bd
   * tea-rags-mcp-35v4v); `findingCount` on a row stays the family's FULL
   * total, so row and section reconcile independently.
   */
  truncated?: number;
}

export type ArchitectureSectionResult = ReviewSectionEnvelope & ArchitectureSectionPayload;

/** One section's answer: the envelope plus that section's own payload fields. */
export type ReviewSectionResult =
  | NamingSectionResult
  | IncompleteChangeSectionResult
  | CohesionSectionResult
  | ArchitectureSectionResult
  | ReviewSectionEnvelope;

/** What one read of the change says about itself, beside the sections' answers. */
export interface ReviewChangesReviewBlock {
  /** The working tree the change was read from: `path` beside `project`, else the addressed tree. */
  workTree: string;
  /** The ref the request named (`HEAD` when none). */
  base: string;
  /** The commit the change was read against: `base`'s merge-base with HEAD. */
  mergeBase: string;
  /** Files that differ from what the change was read against, untracked included; with `files`, those of the listed ones. */
  changedFiles: number;
  /** Changed files past the cap of 200 — reviewed by neither the envelope nor any section. */
  skipped: number;
  truncated?: { cap: number; skipped: number };
  /** The evidence corpus's lag behind the tree the answer is about; absent when they agree or either is unknown. */
  indexLag?: { indexedCommit: string; treeCommit: string };
  /** Non-fatal observations — an empty diff is one, never a bare `changedFiles: 0`. */
  notices?: string[];
  /** Keyed by section id; a section not requested is OMITTED — absence is not not-built. */
  sections: Partial<Record<ReviewSectionId, ReviewSectionResult>>;
}

export interface ReviewChangesResult {
  review: ReviewChangesReviewBlock;
  /** How far the caller's tree is from the index this answer read (bd tea-rags-mcp-xi2r9); absent only when no overlay is wired. */
  workingTree?: WorkingTreeMarker;
}
