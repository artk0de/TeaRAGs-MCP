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
   * Each file's PRIMARY type, last namespace segment (bd tea-rags-mcp-xb669.6)
   * — what tells an edge reaching the target's role from one reaching only a
   * constant nested in it. Absent: no edge is excluded as a constant reference.
   */
  filePrimaryTypes?: ReadonlyMap<RelPath, string>;
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
  readonly byLocality: ReadonlyMap<NormLocality, ReadonlyMap<string, number>>;
  /** The direction test this ledger ran over its role pairs (bd tea-rags-mcp-xb669.8). */
  readonly significance: DependencyNormsSignificance;
  /**
   * The direction test of roleSrc → roleDst, localities pooled — defined for
   * every pair, including one no edge ever produced (p = 1, never
   * significant) and a same-role pair (out of scope: p = 1).
   */
  testDirection: (roleSrc: string, roleDst: string) => NormDirectionTest;
  readonly pairCount: number;
}

/**
 * One directed role pair read against its reverse (bd tea-rags-mcp-xb669.8):
 * the exact two-sided sign test of n(roleSrc → roleDst) against
 * n(roleDst → roleSrc) at p = ½, localities pooled.
 */
export interface NormDirectionTest {
  /** Edges roleSrc → roleDst, every locality. */
  support: number;
  /** Edges roleDst → roleSrc, every locality. */
  reverseSupport: number;
  /** The sign test's two-sided p — 1 for a same-role or edgeless pair. */
  pValue: number;
  /** Benjamini–Hochberg rejected the pair over the ledger's family: it has an established direction. */
  significant: boolean;
}

/**
 * Every language family's ledger (bd tea-rags-mcp-xb669.7). A role name is a
 * word of ONE language's vocabulary — a Ruby `form` and a TypeScript `form`
 * share a spelling, not a habit — so role statistics never pool across
 * families: each family counts its own pairs and role marginals and runs its
 * own direction test.
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

export type PlannedEdgeVerdictKind = "conforms" | "misfit" | "insufficientSupport";

/**
 * The write-time answer for one planned edge (bd tea-rags-mcp-23iii). Since
 * bd tea-rags-mcp-xb669.8: `misfit` = the edge runs against its role pair's
 * established direction (a first edge against a one-way pair included);
 * `conforms` = any other direction the ledger holds an edge for;
 * `insufficientSupport` = no established pattern — a direction nobody wrote
 * whose pair has no significant direction. That last answer is what diff time
 * reads as a NEW_PATTERN (xb669.3 / xb669.2); the whole-repo report never
 * names one.
 */
export interface PlannedEdgeVerdict {
  kind: PlannedEdgeVerdictKind;
  /** Edges roleSrc → roleDst the ledger holds, localities pooled. */
  pairSupport: number;
  /** The pair's two-sided sign-test p. */
  pValue: number;
  /** MISFIT only: the direction the project established for the pair. */
  establishedDirection?: DependencyNormEstablishedDirection;
}

/** The one verdict the whole-repo report lists; every other edge CONFORMS and is not listed. */
export type NormFindingKind = "misfit";

/** The direction a role pair significantly holds — the one a MISFIT runs against. */
export interface DependencyNormEstablishedDirection {
  roleSrc: string;
  roleDst: string;
  /** Edges along it, localities pooled. */
  support: number;
}

/** One edge against its role pair's established direction, with the evidence that makes it one. */
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
  /** Edges roleSrc → roleDst the ledger holds, localities pooled — the minority side. */
  pairSupport: number;
  /** The pair's two-sided sign-test p, rejected by BH over the ledger's family. */
  pValue: number;
  /** The direction the edge runs against: roleDst → roleSrc and its support. */
  establishedDirection: DependencyNormEstablishedDirection;
}

export interface DependencyNormsSummary {
  /** Files judged with a strong role; the judging unit. */
  roleFileCount: number;
  /** Files whose only role is a project suffix — never asserted (naming's entry gate). */
  weakRoleFileCount: number;
  /**
   * Of `weakRoleFileCount`, files whose primary type only shapes the I/O of
   * the function the file is named for (bd tea-rags-mcp-xb669.6).
   */
  ioShapeRoleFileCount: number;
  /** Graph files with no role assignment at all. */
  untypedFileCount: number;
  /** Edges with both endpoints strongly typed — the only ones norms see. */
  typedEdgeCount: number;
  /** Typed edges judged against their family's ledger — each one conforming or a finding. */
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
    /**
     * Typed edges whose endpoints sit in different language families (bd
     * tea-rags-mcp-xb669.7) — two role vocabularies, no ledger to judge
     * against. Counted in `typedEdgeCount`, absent from `judgedEdgeCount`.
     */
    crossLanguageEdgeCount: number;
    /**
     * Typed edges whose recorded reference names a constant NESTED in the
     * target's primary type (`BaseAdapter::RateLimitError`) and that carry no
     * definite resolved call (bd tea-rags-mcp-xb669.6) — a dependency on an
     * error class or a constant, not on the target's role. Counted in
     * `typedEdgeCount`, absent from `judgedEdgeCount` and from every ledger.
     */
    constantReferenceEdgeCount: number;
    /**
     * Typed edges carrying no resolved call — `callWeight` 0 (bd
     * tea-rags-mcp-4vj2u): the source names the target (a factory `.new`, a
     * subtype registry, an initializer's config, a type-only import) but
     * never runs its logic, so an inversion along it is no layering mistake.
     * Still PRECEDENT: the ledgers count it, because the direction of
     * knowledge is set by every reference. A nested constant reference is
     * counted under its own reason, never here. Counted in `typedEdgeCount`,
     * absent from `judgedEdgeCount`.
     */
    uncalledEdgeCount: number;
    /**
     * Typed edges whose EVERY resolved call went through a framework's
     * interface — `frameworkRoutedCallWeight` covers the whole `callWeight`
     * (bd tea-rags-mcp-4vj2u): `Worker.perform_async(…)` routed to
     * `Worker#perform` knows the worker's framework contract, not its logic.
     * Precedent like an uncalled edge, never a finding; counted in
     * `typedEdgeCount`, absent from `judgedEdgeCount`.
     */
    frameworkRoutedEdgeCount: number;
    /**
     * Typed edges an endpoint of which carries a DISPLACED role (bd
     * tea-rags-mcp-4vj2u): a head noun read outside the role's conventional
     * directories, or with a call shape its home's carriers do not have. Only
     * edges no edge-level reason above already excluded. Precedent, never a
     * finding; counted in `typedEdgeCount`, absent from `judgedEdgeCount`.
     */
    displacedRoleEdgeCount: number;
  };
}

/**
 * One ledger's direction test (bd tea-rags-mcp-xb669.8), the dependency
 * analogue of the co-change pair gate's `CochangeSignificanceSummary`.
 */
export interface DependencyNormsSignificance {
  method: "directionInversion";
  /** The false-discovery rate BH controls — the co-change gate's q. */
  q: number;
  /** m — unordered role pairs {A, B}, A ≠ B, holding at least one edge either way. */
  familySize: number;
  /** Pairs BH rejects: each has an established direction. */
  significantPairCount: number;
  /**
   * Of `significantPairCount`, pairs no edge runs against — they fix a
   * direction but carry no MISFIT.
   */
  oneWayPairCount: number;
}

/** One family's ledger as the report shows it: its own direction test over its own pairs. */
export interface DependencyNormsFamilyLedger {
  family: string;
  pairCount: number;
  significance: DependencyNormsSignificance;
}

export interface DependencyNormsReport {
  summary: DependencyNormsSummary;
  /** One entry per language family holding a typed edge, in code-point order of family id. */
  ledgers: DependencyNormsFamilyLedger[];
  /** By weight, then by path — the order the report lists them. */
  findings: DependencyNormFinding[];
}
