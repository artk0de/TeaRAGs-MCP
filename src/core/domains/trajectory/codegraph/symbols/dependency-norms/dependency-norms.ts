import type { FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import {
  benjaminiHochbergRejectionCount,
  CONVENTIONAL_FDR_Q,
  poissonLowerTail,
} from "../../../../../infra/statistics/index.js";
import { languageFamilyOf } from "../language-family-record.js";
import type {
  DependencyNormFinding,
  DependencyNormsInput,
  DependencyNormsReport,
  DependencyNormsSignificance,
  DependencyNormsSummary,
  NormFindingKind,
  NormLedgerBook,
  NormLedgers,
  NormLocality,
  NormPairTest,
  NormPlannedEdge,
  PlannedEdgeVerdict,
} from "./types.js";

/**
 * Empirical dependency norms (bd tea-rags-mcp-rpx0v, epic xb669.2): the
 * repository's own P(edge | roleSrc, roleDst, locality), read off the file
 * graph, and the verdict every edge carries. The naming lexicon's CONFORMS /
 * MISFIT for dependencies.
 *
 * THE VERDICT IS A SIGNIFICANCE TEST, NOT A SUPPORT CUT (bd
 * tea-rags-mcp-xb669.8). Per ledger and locality, independence of roles
 * predicts λ = out(roleSrc)·in(roleDst)/N edges for a pair; its p-value is the
 * Poisson lower tail P(X ≤ observed | λ); Benjamini–Hochberg at the co-change
 * pair gate's q runs over the a-priori family of every pair with λ > 0. A pair
 * BH rejects is significantly RARER than its roles' activity predicts: a MISFIT
 * when the roles meet through a conforming mid role (the expected path), else
 * a NEW_PATTERN. Every other observed pair CONFORMS and is not listed. Measured
 * on taxdome (bd tea-rags-mcp-xb669.4): every support cut left only singleton
 * pairs as findings at ~3% precision — a singleton is noise between two
 * rarely-active roles and signal between two roles that meet constantly
 * elsewhere, and only the expectation tells them apart.
 *
 * READ-TIME: the whole computation runs over the graph the report already
 * reads plus the role map naming's type-role layer derives — nothing is
 * persisted, so the norms are as fresh as the graph and cost no payload keys.
 *
 * ROLES are the caller's contract: the file's PRIMARY type's role, strong
 * (inheritance / directory evidence) only. Edges touching a weak or untyped
 * file never enter a ledger — a suffix never asserts a role, so it must not
 * misfit an edge either (naming's entry gate, bd tea-rags-mcp-vi0wx).
 */
/**
 * The ledgers the report walk and the write-time verdict share (bd
 * tea-rags-mcp-23iii): pair support per (roleSrc, roleDst, locality) and the
 * independence test over it (bd tea-rags-mcp-xb669.8). Built once
 * per input — `computeDependencyNorms` consumes it for every edge it walks,
 * `judgePlannedEdge` for one planned edge a writer is about to add.
 *
 * ONE LEDGER PER LANGUAGE FAMILY (bd tea-rags-mcp-xb669.7): role statistics
 * never pool across languages, and an edge whose endpoints sit in different
 * families enters no ledger — see {@link NormLedgerBook}.
 */
export function buildNormLedgers(input: DependencyNormsInput): NormLedgerBook {
  const { graph, fileRoles } = input;
  const roleOf = (relPath: RelPath) => fileRoles.get(relPath);
  const familyOfEdge = edgeFamilyResolver(graph);
  const localityOf = localityResolver(input);
  const isConstantReference = constantReferenceTest(input);
  const tallies = new Map<string, NormLedgerTally>();
  for (const edge of graph.edges) {
    const sourceRole = roleOf(edge.sourceRelPath);
    const targetRole = roleOf(edge.targetRelPath);
    if (sourceRole?.strong !== true || targetRole?.strong !== true) continue;
    const family = familyOfEdge(edge.sourceRelPath, edge.targetRelPath);
    if (family === undefined || isConstantReference(edge)) continue;
    let tally = tallies.get(family);
    if (tally === undefined) {
      tally = { pairs: new Map(), byLocality: new Map() };
      tallies.set(family, tally);
    }
    const { pairs, byLocality } = tally;
    const { role: roleSrc } = sourceRole;
    const { role: roleDst } = targetRole;
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const key = `${roleSrc}\u0000${roleDst}\u0000${locality}`;
    const support = (pairs.get(key) ?? 0) + 1;
    pairs.set(key, support);
    const local = byLocality.get(locality) ?? new Map<string, number>();
    local.set(`${roleSrc}\u0000${roleDst}`, support);
    byLocality.set(locality, local);
  }

  const families = new Map<string, NormLedgers>();
  for (const family of [...tallies.keys()].sort(compareCodePoints)) {
    const tally = tallies.get(family);
    if (tally !== undefined) families.set(family, familyLedger(family, tally));
  }
  const forLanguage = (language: string): NormLedgers => {
    const family = languageFamilyOf(language);
    return families.get(family) ?? familyLedger(family, { pairs: new Map(), byLocality: new Map() });
  };
  return {
    families,
    forLanguage,
    forEdge: (sourceLanguage, targetLanguage) => {
      const family = sharedFamily(sourceLanguage, targetLanguage);
      return family === undefined ? undefined : forLanguage(family);
    },
  };
}

interface NormLedgerTally {
  pairs: Map<string, number>;
  byLocality: Map<NormLocality, Map<string, number>>;
}

/** One locality's marginals: edges each role sends and receives, and their total N. */
interface LocalityMarginals {
  out: Map<string, number>;
  in: Map<string, number>;
  total: number;
}

function localityMarginals(local: ReadonlyMap<string, number>): LocalityMarginals {
  const marginals: LocalityMarginals = { out: new Map(), in: new Map(), total: 0 };
  for (const [key, support] of local) {
    const [roleSrc, roleDst] = key.split("\u0000");
    marginals.out.set(roleSrc, (marginals.out.get(roleSrc) ?? 0) + support);
    marginals.in.set(roleDst, (marginals.in.get(roleDst) ?? 0) + support);
    marginals.total += support;
  }
  return marginals;
}

/**
 * One family's ledger and its independence test. The family BH controls is
 * fixed before looking at any pair's count: every (roleSrc, roleDst) of a
 * locality whose λ is positive, written or not — the unwritten ones are
 * tested members (their p is e^−λ), never left out because nobody wrote them.
 * A pair is testable when even a lone edge would clear q (P(X ≤ 1 | λ) ≤ q):
 * BH's per-rank bound never exceeds q, so an untestable pair is never rare,
 * whatever the family.
 */
function familyLedger(family: string, { pairs, byLocality }: NormLedgerTally): NormLedgers {
  const q = CONVENTIONAL_FDR_Q;
  const marginalsOf = new Map<NormLocality, LocalityMarginals>();
  for (const [locality, local] of byLocality) marginalsOf.set(locality, localityMarginals(local));

  const expectedOf = (roleSrc: string, roleDst: string, locality: NormLocality): number => {
    const marginals = marginalsOf.get(locality);
    if (marginals === undefined || marginals.total === 0) return 0;
    return ((marginals.out.get(roleSrc) ?? 0) * (marginals.in.get(roleDst) ?? 0)) / marginals.total;
  };

  const familyPValues: number[] = [];
  let testablePairCount = 0;
  for (const [locality, marginals] of marginalsOf) {
    const local = byLocality.get(locality);
    for (const roleSrc of marginals.out.keys()) {
      for (const roleDst of marginals.in.keys()) {
        const expected = expectedOf(roleSrc, roleDst, locality);
        familyPValues.push(poissonLowerTail(local?.get(`${roleSrc}\u0000${roleDst}`) ?? 0, expected));
        if (poissonLowerTail(1, expected) <= q) testablePairCount++;
      }
    }
  }
  familyPValues.sort((a, b) => a - b);
  const rarePairCount = benjaminiHochbergRejectionCount(familyPValues, familyPValues.length, q);
  // BH rejects every p at or below the largest p it rejected.
  const rarePValueCut = rarePairCount === 0 ? -1 : familyPValues[rarePairCount - 1];

  const significance: DependencyNormsSignificance = {
    method: "poissonIndependenceNull",
    q,
    familySize: familyPValues.length,
    testablePairCount,
    rarePairCount,
  };
  const testPair = (roleSrc: string, roleDst: string, locality: NormLocality): NormPairTest => {
    const support = pairs.get(`${roleSrc}\u0000${roleDst}\u0000${locality}`) ?? 0;
    const expectedSupport = expectedOf(roleSrc, roleDst, locality);
    const pValue = poissonLowerTail(support, expectedSupport);
    const testable = poissonLowerTail(1, expectedSupport) <= q;
    return { support, expectedSupport, pValue, testable, rare: testable && pValue <= rarePValueCut };
  };
  return { family, pairs, byLocality, significance, testPair, pairCount: pairs.size };
}

/**
 * The family BOTH languages belong to, or `undefined` when they differ or one
 * is unknown. Family, not language: `languageFamilyOf` is the codegraph's own
 * partition of run-global name-keyed maps (bd tea-rags-mcp-nbf8q) — TypeScript
 * and JavaScript resolve into each other, so they share one import graph and
 * one role vocabulary; any other language is a family of its own.
 */
function sharedFamily(sourceLanguage: string | undefined, targetLanguage: string | undefined): string | undefined {
  if (sourceLanguage === undefined || targetLanguage === undefined) return undefined;
  const family = languageFamilyOf(sourceLanguage);
  return languageFamilyOf(targetLanguage) === family ? family : undefined;
}

function edgeFamilyResolver(graph: DependencyNormsInput["graph"]) {
  const languageOf = new Map<RelPath, string>();
  for (const f of graph.files) languageOf.set(f.relPath, f.language);
  return (sourceRelPath: RelPath, targetRelPath: RelPath) =>
    sharedFamily(languageOf.get(sourceRelPath), languageOf.get(targetRelPath));
}

/**
 * The confidence-weighted call sum of ONE full-confidence resolved call — the
 * least that proves an edge calls INTO its target, whatever constant its
 * recorded reference names. A dynamic fan-out share sums below it.
 */
const DEFINITE_CALL_WEIGHT = 1;

/** A leading reference-channel marker (`zeitwerk:`), never a `::` namespace separator. */
const REFERENCE_CHANNEL_MARKER = /^[A-Za-z_-]+:(?!:)/;
const NAMESPACE_SEPARATOR = /::|\./;

/**
 * Whether an edge's only evidence is a constant NESTED in the target's primary
 * type (bd tea-rags-mcp-xb669.6): its recorded reference is qualified THROUGH
 * the primary (`BaseAdapter::RateLimitError` into base_adapter.rb) to a name
 * other than the primary, and no definite call backs it. Such an edge depends
 * on an error class or a constant, not on what the target file IS — counting
 * it would make `rescue Adapter::Error` a worker→adapter precedent.
 *
 * Bounded by the persisted fact: an edge row keeps the FIRST reference the
 * walk saw, so a file naming the nested constant before the primary itself
 * reads as a constant reference — the call-weight guard keeps every edge that
 * provably calls in.
 */
function constantReferenceTest({ filePrimaryTypes }: DependencyNormsInput) {
  return (edge: FileDependencyGraph["edges"][number]): boolean => {
    if (filePrimaryTypes === undefined || edge.importText === undefined || edge.importText === null) return false;
    if (edge.callWeight >= DEFINITE_CALL_WEIGHT) return false;
    const primary = filePrimaryTypes.get(edge.targetRelPath);
    if (primary === undefined) return false;
    const segments = edge.importText.replace(REFERENCE_CHANNEL_MARKER, "").split(NAMESPACE_SEPARATOR);
    const named = segments.pop();
    return named !== primary && segments.includes(primary);
  };
}

function localityResolver({ componentOf }: DependencyNormsInput) {
  return (sourceRelPath: RelPath, targetRelPath: RelPath): NormLocality => {
    if (directoryOf(sourceRelPath) === directoryOf(targetRelPath)) return "sameDirectory";
    if (componentOf) {
      const sourceComponent = componentOf.get(sourceRelPath);
      const targetComponent = componentOf.get(targetRelPath);
      if (sourceComponent !== undefined && sourceComponent === targetComponent) return "sameDomain";
    }
    return "crossDomain";
  };
}

/** The write-time verdict (bd tea-rags-mcp-23iii): "I am about to add this edge — does the project do that?" */
export function judgePlannedEdge(ledgers: NormLedgers, planned: NormPlannedEdge): PlannedEdgeVerdict {
  const { roleSrc, roleDst, locality } = planned;
  const test = ledgers.testPair(roleSrc, roleDst, locality);
  const evidence = { pairSupport: test.support, expectedSupport: test.expectedSupport, pValue: test.pValue };
  if (!test.rare) return { kind: test.support > 0 ? "conforms" : "insufficientSupport", ...evidence };
  const expectedPath = conformingTransit(ledgers, planned);
  return expectedPath ? { kind: "misfit", ...evidence, expectedPath } : { kind: "newPattern", ...evidence };
}

/**
 * The mid role a significantly rare pair's roles meet through instead — both
 * legs written AND conforming under the same test (testable, not rare); the
 * heaviest weaker leg wins, ties by role name. A leg merely written once or
 * twice between roles the null pairs rarely is no route: before bd
 * tea-rags-mcp-xb669.8 any mid role with both legs ≥ 2 qualified, and on
 * taxdome that named a transit for nearly every finding.
 */
function conformingTransit(ledgers: NormLedgers, { roleSrc, roleDst, locality }: NormPlannedEdge) {
  const local = ledgers.byLocality.get(locality) ?? new Map<string, number>();
  const midRoles = new Set<string>();
  for (const key of local.keys()) {
    const [from, to] = key.split("\u0000");
    midRoles.add(from);
    midRoles.add(to);
  }
  const conforms = (from: string, to: string): number => {
    const leg = ledgers.testPair(from, to, locality);
    return leg.support > 0 && leg.testable && !leg.rare ? leg.support : 0;
  };
  let via: string | undefined;
  let viaSupport = 0;
  for (const mid of [...midRoles].sort(compareCodePoints)) {
    if (mid === roleSrc || mid === roleDst) continue;
    const support = Math.min(conforms(roleSrc, mid), conforms(mid, roleDst));
    if (support > viaSupport) {
      via = mid;
      viaSupport = support;
    }
  }
  return via === undefined ? undefined : { via, support: viaSupport };
}

export function computeDependencyNorms(input: DependencyNormsInput): DependencyNormsReport {
  const { graph, fileRoles } = input;
  const roleOf = (relPath: RelPath) => fileRoles.get(relPath);

  let weakRoleFileCount = 0;
  let ioShapeRoleFileCount = 0;
  let untypedFileCount = 0;
  for (const f of graph.files) {
    const role = fileRoles.get(f.relPath);
    if (role === undefined) untypedFileCount++;
    else if (!role.strong) {
      weakRoleFileCount++;
      if (role.weakReason === "ioShape") ioShapeRoleFileCount++;
    }
  }

  const book = buildNormLedgers(input);
  const familyOfEdge = edgeFamilyResolver(graph);
  const localityOf = localityResolver(input);
  const isConstantReference = constantReferenceTest(input);

  const findings: DependencyNormFinding[] = [];
  let crossLanguageEdgeCount = 0;
  let constantReferenceEdgeCount = 0;
  let typedEdgeCount = 0;
  for (const edge of graph.edges) {
    const sourceRole = roleOf(edge.sourceRelPath);
    const targetRole = roleOf(edge.targetRelPath);
    if (sourceRole?.strong !== true || targetRole?.strong !== true) continue;
    typedEdgeCount++;
    const family = familyOfEdge(edge.sourceRelPath, edge.targetRelPath);
    // bd tea-rags-mcp-xb669.7: an edge between two role vocabularies has no
    // ledger to be judged against — UNJUDGED, counted, never a finding.
    if (family === undefined) {
      crossLanguageEdgeCount++;
      continue;
    }
    // bd tea-rags-mcp-xb669.6: a nested constant is no role edge — counted, never judged.
    if (isConstantReference(edge)) {
      constantReferenceEdgeCount++;
      continue;
    }
    const ledgers = book.forLanguage(family);
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const verdict = judgePlannedEdge(ledgers, {
      roleSrc: sourceRole.role,
      roleDst: targetRole.role,
      locality,
    });
    // Every walked edge is written, so its pair's support is ≥ 1: the verdict
    // is a finding or CONFORMS, never `insufficientSupport`.
    if (verdict.kind !== "misfit" && verdict.kind !== "newPattern") continue;
    findings.push(
      finding(family, edge, { roleSrc: sourceRole.role, roleDst: targetRole.role, locality }, verdict.kind, verdict),
    );
  }

  findings.sort(
    (a, b) =>
      (a.kind === "misfit" ? 0 : 1) - (b.kind === "misfit" ? 0 : 1) ||
      b.callWeight - a.callWeight ||
      compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
      compareCodePoints(a.targetRelPath, b.targetRelPath),
  );

  // bd tea-rags-mcp-mv8yv: the pattern scopes the FINDINGS by source, the way
  // every other detector scopes — ledgers, supports and the cut stay
  // whole-graph. Dropped findings are counted, never lost silently.
  const inScope = compilePathPatternMatcher(input.sourcePathPattern);
  const scopedFindings = inScope ? findings.filter((f) => inScope(f.sourceRelPath)) : findings;

  const summary: DependencyNormsSummary = {
    roleFileCount: [...new Set([...fileRoles].filter(([, r]) => r.strong).map(([p]) => p))].length,
    weakRoleFileCount,
    ioShapeRoleFileCount,
    untypedFileCount,
    typedEdgeCount,
    judgedEdgeCount: typedEdgeCount - crossLanguageEdgeCount - constantReferenceEdgeCount,
    violationCount: scopedFindings.length,
    pairCount: [...book.families.values()].reduce((sum, ledger) => sum + ledger.pairCount, 0),
    ...(inScope ? { outOfScopeFindingCount: findings.length - scopedFindings.length } : {}),
    excluded: { crossLanguageEdgeCount, constantReferenceEdgeCount },
  };
  return {
    summary,
    ledgers: [...book.families.values()].map((ledger) => ({
      family: ledger.family,
      pairCount: ledger.pairCount,
      significance: { ...ledger.significance },
    })),
    findings: scopedFindings,
  };
}

function finding(
  family: string,
  edge: { sourceRelPath: RelPath; targetRelPath: RelPath; callWeight: number },
  { roleSrc, roleDst, locality }: NormPlannedEdge,
  kind: NormFindingKind,
  { pairSupport, expectedSupport, pValue, expectedPath }: PlannedEdgeVerdict,
): DependencyNormFinding {
  return {
    kind,
    family,
    sourceRelPath: edge.sourceRelPath,
    targetRelPath: edge.targetRelPath,
    roleSrc,
    roleDst,
    locality,
    callWeight: edge.callWeight,
    pairSupport,
    expectedSupport,
    pValue,
    ...(expectedPath ? { expectedPath } : {}),
  };
}

function directoryOf(relPath: string): string {
  const slash = relPath.lastIndexOf("/");
  return slash === -1 ? "" : relPath.slice(0, slash);
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
