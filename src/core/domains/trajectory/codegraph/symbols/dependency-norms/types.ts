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
  /** The independence test this ledger ran over its role-pair family (bd tea-rags-mcp-xb669.8). */
  readonly significance: DependencyNormsSignificance;
  /**
   * The pair's test against independence of roles in this ledger — defined
   * for every pair, including one no edge (or no role) of the locality ever
   * produced: its λ is then 0 and it is untestable.
   */
  testPair: (roleSrc: string, roleDst: string, locality: NormLocality) => NormPairTest;
  readonly pairCount: number;
}

/**
 * One role pair judged against independence of roles (bd tea-rags-mcp-xb669.8):
 * λ = out(roleSrc)·in(roleDst)/N over the ledger's edges of one locality.
 */
export interface NormPairTest {
  /** Edges the pair holds in this locality. */
  support: number;
  /** λ — the edges independence of roles predicts for the pair. */
  expectedSupport: number;
  /** P(X ≤ support | λ): how surprising so FEW edges are. */
  pValue: number;
  /**
   * Whether even a lone edge would be significant at q — P(X ≤ 1 | λ) ≤ q.
   * An untestable pair can never be rare; with no edge it is unjudgeable.
   */
  testable: boolean;
  /** Benjamini–Hochberg rejected it over the ledger's family: significantly rarer than independence predicts. */
  rare: boolean;
}

/**
 * Every language family's ledger (bd tea-rags-mcp-xb669.7). A role name is a
 * word of ONE language's vocabulary — a Ruby `form` and a TypeScript `form`
 * share a spelling, not a habit — so role statistics never pool across
 * families: each family counts its own pairs and role marginals and runs its
 * own independence test.
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

/**
 * The write-time answer for one planned edge (bd tea-rags-mcp-23iii). Since
 * bd tea-rags-mcp-xb669.8: `misfit` / `newPattern` = the pair is significantly
 * rarer than independence of roles predicts; `conforms` = an observed pair
 * that is not; `insufficientSupport` = a pair with no edge whose absence the
 * test cannot call significant — no evidence either way.
 */
export interface PlannedEdgeVerdict {
  kind: PlannedEdgeVerdictKind;
  pairSupport: number;
  /** λ — the edges independence of roles predicts for the pair. */
  expectedSupport: number;
  /** P(X ≤ pairSupport | λ). */
  pValue: number;
  /** MISFIT only: the conforming transit the planned edge should follow. */
  expectedPath?: DependencyNormExpectedPath;
}

/** The two verdicts a significantly rare edge can carry; every other edge CONFORMS and is not listed. */
export type NormFindingKind = "misfit" | "newPattern";

/**
 * The transit a MISFIT's roles meet through instead: `roleSrc -> via -> roleDst`,
 * both legs observed AND conforming under the same test (testable, not rare) —
 * a leg of one or two edges between roles the null pairs rarely is no route.
 */
export interface DependencyNormExpectedPath {
  /** The mid role. */
  via: string;
  /** The weaker leg's pair support — the precedent the direct edge bypasses. */
  support: number;
}

/** One significantly rare file edge, with the evidence that makes it one. */
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
  /** File edges this pair's ledger holds in this locality. */
  pairSupport: number;
  /** λ — the edges independence of roles predicts for the pair; above `pairSupport` by construction. */
  expectedSupport: number;
  /** P(X ≤ pairSupport | λ), rejected by BH over the ledger's family. */
  pValue: number;
  /** MISFIT only: the conforming transit path the edge should follow. */
  expectedPath?: DependencyNormExpectedPath;
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
  };
}

/**
 * One ledger's independence test (bd tea-rags-mcp-xb669.8), the dependency
 * analogue of the co-change pair gate's `CochangeSignificanceSummary`.
 */
export interface DependencyNormsSignificance {
  method: "poissonIndependenceNull";
  /** The false-discovery rate BH controls — the co-change gate's q. */
  q: number;
  /**
   * m — the A-PRIORI family: every (roleSrc, roleDst, locality) whose λ > 0,
   * i.e. roleSrc has out-edges and roleDst in-edges in that locality. Pairs no
   * edge holds are members too, never only the observed ones.
   */
  familySize: number;
  /** Family pairs where even a lone edge could be significant — the rest can never be rare. */
  testablePairCount: number;
  /** Pairs BH rejects — written or not. */
  rarePairCount: number;
}

/** One family's ledger as the report shows it: its own independence test over its own pairs. */
export interface DependencyNormsFamilyLedger {
  family: string;
  pairCount: number;
  significance: DependencyNormsSignificance;
}

export interface DependencyNormsReport {
  summary: DependencyNormsSummary;
  /** One entry per language family holding a typed edge, in code-point order of family id. */
  ledgers: DependencyNormsFamilyLedger[];
  /** MISFITs first, then by weight, then by path — the order the report lists them. */
  findings: DependencyNormFinding[];
}
