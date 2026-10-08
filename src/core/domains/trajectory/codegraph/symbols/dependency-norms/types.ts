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
  /**
   * Picomatch glob scoping the FINDINGS by source file (bd tea-rags-mcp-mv8yv),
   * the way every other detector scopes. Ledgers, supports and the cut stay
   * whole-graph; findings the scope drops are counted in
   * `summary.outOfScopeFindingCount`, never lost silently.
   */
  sourcePathPattern?: string;
}

/** How far apart an edge's endpoints are — the ledger an edge is judged against. */
export type NormLocality = "sameDirectory" | "sameDomain" | "crossDomain";

/**
 * ONE language family's precedent ledgers, built once per input (see
 * {@link NormLedgerBook}) and shared by the report walk and the write-time
 * verdict. Key format of `pairs` and of each
 * `byLocality` map is `${roleSrc}\u0000${roleDst}\u0000${locality}` and
 * `${roleSrc}\u0000${roleDst}` respectively — compose through
 * {@link judgePlannedEdge}, never by hand.
 */
export interface NormLedgers {
  /** The language family whose edges this ledger counts — `languageFamilyOf` of both endpoints. */
  readonly family: string;
  readonly pairs: ReadonlyMap<string, number>;
  /** File edges each role carries across this family's ledgers — the frequency test a NEW_PATTERN needs. */
  readonly activity: ReadonlyMap<string, number>;
  readonly byLocality: ReadonlyMap<NormLocality, ReadonlyMap<string, number>>;
  readonly threshold: DependencyNormsThreshold;
  /** The un-rounded predicate: `>= threshold` AND strictly above the majority floor. */
  admitsPairSupport: (value: number) => boolean;
  readonly pairCount: number;
}

/**
 * Every language family's ledger (bd tea-rags-mcp-xb669.7). A role name is a
 * word of ONE language's vocabulary — a Ruby `form` and a TypeScript `form`
 * share a spelling, not a habit — so role statistics never pool across
 * families: each family counts its own pairs and activity and cuts its own
 * pair-support distribution.
 */
export interface NormLedgerBook {
  /** Each family's ledger, in code-point order of family id. */
  readonly families: ReadonlyMap<string, NormLedgers>;
  /** `language`'s family ledger — an empty one when no typed edge of that family exists. */
  forLanguage: (language: string) => NormLedgers;
  /**
   * The ledger an edge between these languages is judged against, or
   * `undefined` when its endpoints sit in different families (or a language
   * is unknown): such a pair mixes two role vocabularies, so no family's
   * ledger has ever counted it and judging it there would flag it by
   * construction.
   */
  forEdge: (sourceLanguage: string | undefined, targetLanguage: string | undefined) => NormLedgers | undefined;
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
  /** The language family whose ledger judged the edge. */
  family: string;
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
  /** Typed edges judged against their family's ledger — each one precedented or a finding. */
  judgedEdgeCount: number;
  violationCount: number;
  /** Distinct (family, roleSrc, roleDst, locality) entries, summed over family ledgers. */
  pairCount: number;
  /**
   * Findings no source file matching `sourcePathPattern` carries; present
   * only when scoped (bd tea-rags-mcp-mv8yv).
   */
  outOfScopeFindingCount?: number;
  excluded: {
    /** Rare pairs whose BOTH roles are rare — too little support to name a pattern. */
    lowRoleSupportEdgeCount: number;
    /**
     * Typed edges whose endpoints sit in different language families (bd
     * tea-rags-mcp-xb669.7) — two role vocabularies, no ledger to judge
     * against. Counted in `typedEdgeCount`, absent from `judgedEdgeCount`.
     */
    crossLanguageEdgeCount: number;
  };
}

/** The adaptive cut over pair support, serialized — `admits` stays with the live threshold object. */
export interface DependencyNormsThreshold {
  method: "otsu" | "majority";
  threshold: number;
  separability?: number;
}

/** One family's ledger as the report shows it: its own adaptive cut over its own pairs. */
export interface DependencyNormsFamilyLedger {
  family: string;
  pairCount: number;
  threshold: DependencyNormsThreshold;
}

export interface DependencyNormsReport {
  summary: DependencyNormsSummary;
  /** One entry per language family holding a typed edge, in code-point order of family id. */
  ledgers: DependencyNormsFamilyLedger[];
  /** MISFITs first, then by weight, then by path — the order the report lists them. */
  findings: DependencyNormFinding[];
}
