import type { DependencyNormFileRole, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";

/** Everything the norms computation reads — all of it already in memory at report time. */
export interface DependencyNormsInput {
  graph: FileDependencyGraph;
  /** Each file's primary-type role; absent = untyped, `strong: false` = project-suffix only. */
  fileRoles: ReadonlyMap<RelPath, DependencyNormFileRole>;
  /**
   * The domain partition's component per file (bd tea-rags-mcp-r8hme.30) —
   * `sameDomain` locality reads off it. Absent: two-level locality only.
   */
  componentOf?: ReadonlyMap<RelPath, string>;
}

/** How far apart an edge's endpoints are — the ledger an edge is judged against. */
export type NormLocality = "sameDirectory" | "sameDomain" | "crossDomain";

/**
 * The project's precedent ledgers, built once per input and shared by the
 * report walk and the write-time verdict. Key format of `pairs` and of each
 * `byLocality` map is `${roleSrc}\u0000${roleDst}\u0000${locality}` and
 * `${roleSrc}\u0000${roleDst}` respectively — compose through
 * {@link judgePlannedEdge}, never by hand.
 */
export interface NormLedgers {
  readonly pairs: ReadonlyMap<string, number>;
  /** File edges each role carries across every ledger — the frequency test a NEW_PATTERN needs. */
  readonly activity: ReadonlyMap<string, number>;
  readonly byLocality: ReadonlyMap<NormLocality, ReadonlyMap<string, number>>;
  readonly threshold: DependencyNormsThreshold;
  /** The un-rounded predicate: `>= threshold` AND strictly above the majority floor. */
  admitsPairSupport: (value: number) => boolean;
  readonly pairCount: number;
}

/** The edge the writer is about to add, in the same terms the ledgers count. */
export interface NormPlannedEdge {
  roleSrc: string;
  roleDst: string;
  locality: NormLocality;
}

export type PlannedEdgeVerdictKind = "conforms" | "misfit" | "newPattern" | "insufficientSupport";

/** The write-time answer for one planned edge (bd tea-rags-mcp-23iii). */
export interface PlannedEdgeVerdict {
  kind: PlannedEdgeVerdictKind;
  pairSupport: number;
  /** MISFIT only: the frequent transit the planned edge should follow. */
  expectedPath?: DependencyNormExpectedPath;
}

/** The two verdicts a precedent-less edge can carry; a precedented edge CONFORMS and is not listed. */
export type NormFindingKind = "misfit" | "newPattern";

/** The frequent transit that replaces a MISFIT's missing direct precedent. */
export interface DependencyNormExpectedPath {
  /** The mid role: `roleSrc -> via -> roleDst`, both legs precedented. */
  via: string;
  /** The weaker leg's pair support — the precedent the direct edge bypasses. */
  support: number;
}

/** One precedent-less file edge, with the evidence that makes it one. */
export interface DependencyNormFinding {
  kind: NormFindingKind;
  sourceRelPath: RelPath;
  targetRelPath: RelPath;
  roleSrc: string;
  roleDst: string;
  locality: NormLocality;
  callWeight: number;
  /** File edges this pair's ledger holds in this locality — below the cut by construction. */
  pairSupport: number;
  /** MISFIT only: the frequent transit path the edge should follow. */
  expectedPath?: DependencyNormExpectedPath;
}

export interface DependencyNormsSummary {
  /** Files judged with a strong role; the judging unit. */
  roleFileCount: number;
  /** Files whose only role is a project suffix — never asserted (naming's entry gate). */
  weakRoleFileCount: number;
  /** Graph files with no role assignment at all. */
  untypedFileCount: number;
  /** Edges with both endpoints strongly typed — the only ones norms see. */
  typedEdgeCount: number;
  /** Same set, walked: every typed edge is either precedented or judged. */
  judgedEdgeCount: number;
  violationCount: number;
  /** Distinct (roleSrc, roleDst, locality) ledgers. */
  pairCount: number;
  excluded: {
    /** Rare pairs whose BOTH roles are rare — too little support to name a pattern. */
    lowRoleSupportEdgeCount: number;
  };
}

/** The adaptive cut over pair support, serialized — `admits` stays with the live threshold object. */
export interface DependencyNormsThreshold {
  method: "otsu" | "majority";
  threshold: number;
  separability?: number;
}

export interface DependencyNormsReport {
  summary: DependencyNormsSummary;
  threshold: DependencyNormsThreshold;
  /** MISFITs first, then by weight, then by path — the order the report lists them. */
  findings: DependencyNormFinding[];
}
