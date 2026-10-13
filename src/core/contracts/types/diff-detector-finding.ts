/**
 * The diff-scoped finding contract (bd tea-rags-mcp-r8hme.44): what
 * `review_changes`' architecture section lists per detector family, and the
 * per-family verdict row beside it. Lives in contracts — not in the ops run
 * that emits it — because the public review DTO speaks it; a public DTO
 * defined by internal ops was an SDP violation (api/public/dto -> api).
 *
 * A finding is keyed by STRUCTURED endpoints whose field names mirror the
 * `ArchitectureViolation` endpoint shapes (`sourceComponent`/`targetComponent`,
 * `sourceRelPath`/`targetRelPath`, `relPath`, `component`,
 * `componentA`/`componentB`), so a fingerprint over "detector + endpoints"
 * (bd tea-rags-mcp-89k7k.1.7) never parses prose. Evidence is structured per
 * family. The reviewer-facing `subject` is RENDERED from the endpoints by
 * {@link renderDiffFindingSubject} — never authored beside them; `detail` is
 * the one sentence a reviewer reads.
 */

import type {
  ArchitectureMaintenanceCost,
  CochangeSignificanceSummary,
  SilentCouplingGroupDrillDown,
  SilentCouplingGroupPartner,
  SilentCouplingReportSummary,
} from "./architecture-report.js";
import type { RelPath } from "./codegraph.js";

/** The detector families the diff run judges. */
export type DiffDetectorFamily =
  | "stableDependencies"
  | "leakingAbstraction"
  | "cycles"
  | "mainSequence"
  | "silentCoupling"
  | "facadeContract"
  | "splitCandidates";

// ── Endpoints ────────────────────────────────────────────────────────────────

/** One file edge the diff serves — leakingAbstraction, cycles. */
export interface DiffFindingFileEdgeEndpoints {
  kind: "fileEdge";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
}

/**
 * A component pair judged through the file edge carrying it —
 * stableDependencies. The pair is what the whole-repo SDP violation keys on;
 * the file edge is the diff's own.
 */
export interface DiffFindingComponentEdgeEndpoints {
  kind: "componentEdge";
  sourceComponent: string;
  targetComponent: string;
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
}

/**
 * Two files coupled by history — a silentCoupling pair. ORIENTED:
 * `sourceRelPath` is the diff's changed side, unlike the whole-repo violation
 * whose pair is lexicographic; a key over both sorts the two paths.
 */
export interface DiffFindingFilePairEndpoints {
  kind: "filePair";
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
}

/** The shared endpoint of a grouped silentCoupling finding — the report group violation's `relPath`. */
export interface DiffFindingFileGroupEndpoints {
  kind: "fileGroup";
  relPath: RelPath;
  /** Admitted pairs in the group — every one listed in the finding's `partners`. */
  partnerCount: number;
}

/** One file of a component — facadeContract: the facade and the module it fronts. */
export interface DiffFindingFileEndpoints {
  kind: "file";
  relPath: RelPath;
  component: string;
}

/** One component — mainSequence (the touched component), splitCandidates split. */
export interface DiffFindingComponentEndpoints {
  kind: "component";
  component: string;
}

/** Two components — a splitCandidates merge (the verdict's `componentA`/`componentB`). */
export interface DiffFindingComponentPairEndpoints {
  kind: "componentPair";
  componentA: string;
  componentB: string;
}

export type DiffFindingEndpoints =
  | DiffFindingFileEdgeEndpoints
  | DiffFindingComponentEdgeEndpoints
  | DiffFindingFilePairEndpoints
  | DiffFindingFileGroupEndpoints
  | DiffFindingFileEndpoints
  | DiffFindingComponentEndpoints
  | DiffFindingComponentPairEndpoints;

// ── Evidence (numbers rounded to 3 decimals, the report's precision) ────────

export interface StableDependencyDiffFindingEvidence {
  sourceInstability: number;
  targetInstability: number;
}

export interface LeakingAbstractionDiffFindingEvidence {
  /** The facade the source ALREADY imports — the pre-diff usage the leak bypasses. */
  facadeRelPath: RelPath;
}

export interface CycleDiffFindingEvidence {
  /** The closed cycle: the judged edge, then the indexed path back; first file = last file. */
  path: RelPath[];
}

export interface MainSequenceDiffFindingEvidence {
  distanceBefore: number;
  distanceAfter: number;
  instabilityBefore: number;
  instabilityAfter: number;
  /**
   * The report's fan counts the exact recompute I' = (Ce+k)/(Ca+Ce+k) read;
   * absent = the catalog served none and the +1-per-edge step applied.
   */
  fanCounts?: { afferentCount: number; efferentCount: number; addedEdgeCount: number };
  /** The cross-component outgoing edges that moved the component. */
  edges: { sourceRelPath: RelPath; targetRelPath: RelPath }[];
}

export interface SilentCouplingPairDiffFindingEvidence {
  support: number;
  strength: number;
  /** λ the configuration null predicts; absent without bundle membership. */
  expectedSupport?: number;
}

export interface SilentCouplingGroupDiffFindingEvidence {
  /** The strongest partners (≤ 3), strongest first — the report group violation's `topPartners`. */
  topPartners: SilentCouplingGroupPartner[];
}

export interface FacadeContractDiffFindingEvidence {
  /** Names the facade stopped re-exporting, sorted, each with its still-importing consumers (sorted, distinct). */
  droppedNames: { name: string; consumers: RelPath[] }[];
}

/** A changed-file list capped at a few exemplars; the count stays whole. */
export interface DiffFindingChangedFiles {
  changedFileCount: number;
  changedFiles: RelPath[];
}

export interface SplitCandidateDiffFindingEvidence {
  /** Co-change groups the component's history splits into. */
  clusterCount: number;
  /** The clusters the diff touches (≥ 2), in the verdict's order. */
  touchedClusters: (DiffFindingChangedFiles & {
    /** 1-based cluster index in the verdict. */
    cluster: number;
    /** Files in the cluster. */
    fileCount: number;
  })[];
}

export interface MergeCandidateDiffFindingEvidence {
  strength: number;
  sideA: DiffFindingChangedFiles;
  sideB: DiffFindingChangedFiles;
}

// ── Finding ──────────────────────────────────────────────────────────────────

interface DiffDetectorFindingCommon {
  /** The reviewer-facing rendering of `endpoints` ({@link renderDiffFindingSubject}). */
  subject: string;
  /** One sentence a reviewer reads. */
  detail: string;
  /**
   * mainSequence only (bd tea-rags-mcp-r8hme.45): EVERY contributing edge of
   * this D-delta terminates inside the measured layering foundation
   * (abstractness 1 at L0, bd tea-rags-mcp-89k7k.35.11). The distance still
   * moved, so the finding stands; triage data, never a suppression. Present
   * only when true.
   */
  foundationTerminal?: true;
  /**
   * stableDependencies only (bd tea-rags-mcp-hbceb): the SOURCE component is
   * a composition root, measured — it holds a module facade nothing in the
   * project imports (bd tea-rags-mcp-r8hme.52.4) — and assembling unstable
   * concretes is its job. Triage data, never a suppression. Present only when
   * true.
   */
  compositionRoot?: true;
  /**
   * mainSequence only (bd tea-rags-mcp-zh3l0): the touched component is an
   * entry surface, measured — it holds a module facade nothing in the project
   * imports (bd tea-rags-mcp-r8hme.52.4) — and the unstable end of the main
   * sequence is where an entry belongs. Triage data, never a suppression.
   * Present only when true.
   */
  entryPoint?: true;
  /**
   * The violation already held before the change — the diff touches it, it
   * did not introduce it. Triage data, never a suppression. Present only when
   * true. Per family:
   * - cycles, leakingAbstraction (bd tea-rags-mcp-89k7k.1.13): the judged
   *   edge is one the base or the indexed graph ALREADY holds.
   * - stableDependencies (bd tea-rags-mcp-89k7k.1.19.2): the diff-added edge
   *   is new, but the diff base already held another edge of the same
   *   component pair.
   * - mainSequence (bd tea-rags-mcp-89k7k.1.19.2): `distanceBefore` was
   *   already past the whole-repo distance threshold.
   * silentCoupling and splitCandidates are history verdicts with no
   * base/after split, and facadeContract is always introduced: those never
   * carry it (spec D9).
   */
  preExisting?: true;
  /**
   * silentCoupling grouped finding only (bd tea-rags-mcp-89k7k.1.14): every
   * partner of the shared endpoint, strongest first — nothing the grouping
   * took is lost.
   */
  partners?: readonly SilentCouplingGroupPartner[];
  /** silentCoupling grouped finding only: the ready-to-run `find_co_changed` drill into the shared endpoint. */
  drillDown?: SilentCouplingGroupDrillDown;
  /**
   * What the finding costs to maintain (bd tea-rags-mcp-r8hme.20) — the
   * whole-repo report's score over the files the finding names. Stamped by
   * the section, not by the run; absent when the git readings are not wired
   * or none of those files is measured.
   */
  maintenanceCost?: ArchitectureMaintenanceCost;
}

/** One diff-scoped judgement: the family, its structured endpoints and evidence, and the reviewer text. */
export type DiffDetectorFinding = DiffDetectorFindingCommon &
  (
    | {
        detector: "stableDependencies";
        endpoints: DiffFindingComponentEdgeEndpoints;
        evidence: StableDependencyDiffFindingEvidence;
      }
    | {
        detector: "leakingAbstraction";
        endpoints: DiffFindingFileEdgeEndpoints;
        evidence: LeakingAbstractionDiffFindingEvidence;
      }
    | { detector: "cycles"; endpoints: DiffFindingFileEdgeEndpoints; evidence: CycleDiffFindingEvidence }
    | {
        detector: "mainSequence";
        endpoints: DiffFindingComponentEndpoints;
        evidence: MainSequenceDiffFindingEvidence;
      }
    | {
        detector: "silentCoupling";
        endpoints: DiffFindingFilePairEndpoints;
        evidence: SilentCouplingPairDiffFindingEvidence;
      }
    | {
        detector: "silentCoupling";
        endpoints: DiffFindingFileGroupEndpoints;
        evidence: SilentCouplingGroupDiffFindingEvidence;
      }
    | {
        detector: "facadeContract";
        endpoints: DiffFindingFileEndpoints;
        evidence: FacadeContractDiffFindingEvidence;
      }
    | {
        detector: "splitCandidates";
        endpoints: DiffFindingComponentEndpoints;
        evidence: SplitCandidateDiffFindingEvidence;
      }
    | {
        detector: "splitCandidates";
        endpoints: DiffFindingComponentPairEndpoints;
        evidence: MergeCandidateDiffFindingEvidence;
      }
  );

/**
 * The silentCoupling row's exclusion counters: the whole-repo summary's
 * classes minus `explainedBySharedNeighbour`, which the production verdict
 * the diff consumes has already applied — its explained pairs never reach the
 * diff, so the row has nothing to count there.
 */
export type DiffSilentCouplingExclusionCounts = Omit<
  SilentCouplingReportSummary["excluded"],
  "explainedBySharedNeighbour"
>;

/** One detector family's verdict for the run. */
export interface DiffDetectorStatus {
  detector: DiffDetectorFamily;
  built: boolean;
  reason?: string;
  findingCount: number;
  /**
   * This family's findings past the slots the section's findings cap
   * allocated it (bd tea-rags-mcp-35v4v) — counted, not listed;
   * `findingCount` stays the family's FULL total. Stamped by the section's
   * cap, not by the run.
   */
  truncated?: number;
  /**
   * Changed files the diff's file cap skipped while this family judged (bd
   * tea-rags-mcp-89k7k.1.9). Present = the verdict is PARTIAL: a zero
   * findingCount over files the run never saw is never a clean pass. Absent
   * on unbuilt rows — `built: false` + `reason` already denies the pass.
   */
  scopeSkippedFiles?: number;
  /**
   * mainSequence only (bd tea-rags-mcp-r8hme.45): touched components the
   * connection-count floor excluded — the small-N class whose instability
   * moves in steps of 1/n. Present when > 0, so a zero over below-floor
   * components never reads as a clean pass; the whole-repo report counts the
   * same exclusions in `summary.mainSequence.excluded.lowConnectionCount`.
   */
  excludedLowConnectionCount?: number;
  /**
   * Co-change pairs read but not judged, by the production exclusion
   * taxonomy's classes (bd tea-rags-mcp-89k7k.1.10) — the
   * `summary.silentCoupling.excluded` vocabulary. silentCoupling row only,
   * and only when the wiring passed the silent-coupling facts.
   */
  excluded?: DiffSilentCouplingExclusionCounts;
  /**
   * How the silentCoupling row's pairs were admitted — the query family of
   * pairs touching the diff (bd tea-rags-mcp-89k7k.1.14). silentCoupling row
   * only, and only when the facts carry it.
   */
  cochangeSignificance?: CochangeSignificanceSummary;
  /**
   * silentCoupling row only (bd tea-rags-mcp-89k7k.1.14): the findings the
   * row's `findingCount` pairs list as — pairs sharing an endpoint become one
   * grouped finding. The section's cap and this row's `truncated` count these
   * findings, so the row reconciles `groupedFindingCount = listed + truncated`.
   */
  groupedFindingCount?: number;
}

// ── Renderings derived from the endpoints ───────────────────────────────────

/**
 * One line naming a grouped silent-coupling finding's shared endpoint and how
 * many files it couples to — the same wording on both surfaces that list
 * silent coupling (the report's group violation and the diff's group finding).
 */
export function silentCouplingGroupSubject(relPath: RelPath, partnerCount: number): string {
  return `${relPath} co-changes significantly with ${partnerCount} files without a structural edge`;
}

/** The reviewer-facing subject of a diff finding, rendered from its endpoints: an edge, a pair, a group, one name. */
export function renderDiffFindingSubject(endpoints: DiffFindingEndpoints): string {
  switch (endpoints.kind) {
    case "fileEdge":
    case "componentEdge":
      return `${endpoints.sourceRelPath} -> ${endpoints.targetRelPath}`;
    case "filePair":
      return `${endpoints.sourceRelPath} ~ ${endpoints.targetRelPath}`;
    case "fileGroup":
      return silentCouplingGroupSubject(endpoints.relPath, endpoints.partnerCount);
    case "file":
      return endpoints.relPath;
    case "component":
      return endpoints.component;
    case "componentPair":
      return `${endpoints.componentA} ~ ${endpoints.componentB}`;
  }
}

/**
 * The files and components a finding's endpoints name — typed, so a consumer
 * maps a component to its files without guessing which endpoint is which. A
 * component-judged file edge names its FILES: the edge the diff added is what
 * carries the cost.
 */
export function diffFindingEndpointRefs(endpoints: DiffFindingEndpoints): {
  files: RelPath[];
  components: string[];
} {
  switch (endpoints.kind) {
    case "fileEdge":
    case "componentEdge":
    case "filePair":
      return { files: [endpoints.sourceRelPath, endpoints.targetRelPath], components: [] };
    case "fileGroup":
    case "file":
      return { files: [endpoints.relPath], components: [] };
    case "component":
      return { files: [], components: [endpoints.component] };
    case "componentPair":
      return { files: [], components: [endpoints.componentA, endpoints.componentB] };
  }
}
