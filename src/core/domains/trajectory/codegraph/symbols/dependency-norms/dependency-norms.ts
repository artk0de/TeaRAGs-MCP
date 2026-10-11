import type { DependencyNormFileRole, FileDependencyGraph, RelPath } from "../../../../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import {
  benjaminiHochbergRejectionCount,
  CONVENTIONAL_FDR_Q,
  signTestPValue,
} from "../../../../../primitives/math/index.js";
import { languageFamilyOf } from "../language-family-record.js";
import type {
  DependencyNormEstablishedDirection,
  DependencyNormFinding,
  DependencyNormsInput,
  DependencyNormsReport,
  DependencyNormsSignificance,
  DependencyNormsSummary,
  NormDirectionTest,
  NormLedgerBook,
  NormLedgers,
  NormLocality,
  NormPlannedEdge,
  PlannedEdgeVerdict,
} from "./types.js";

/**
 * Empirical dependency norms (bd tea-rags-mcp-rpx0v, epic xb669.2): the
 * repository's own role-pair ledgers, read off the file graph, and the
 * verdict every edge carries. The naming lexicon's CONFORMS / MISFIT for
 * dependencies.
 *
 * MISFIT IS A DIRECTION INVERSION (bd tea-rags-mcp-xb669.8, owner decision).
 * Per ledger, localities pooled, every unordered role pair {A, B} (A ≠ B)
 * holding an edge is an exact two-sided sign test of n(A→B) against n(B→A) at
 * p = ½; Benjamini–Hochberg at the co-change pair gate's q runs over those
 * pairs. A rejected pair has an ESTABLISHED direction, and every edge against
 * it is a MISFIT. Every other edge CONFORMS and is not listed — a mutual pair,
 * a one-way pair, a pair too small to establish anything, a same-role pair.
 * Two independence nulls failed first, measured on taxdome: Poisson
 * λ = out·in/N (precision 0/20) and a negative-binomial refit (0 testable
 * pairs) — role pairs are structurally zero or dominated by conventions, so
 * "rarer than independence predicts" flags conventions, not mistakes. The
 * direction test needs no null over roles at all: it compares a pair with its
 * own reverse. NEW_PATTERN — a pair with no history — is a diff-time verdict
 * (xb669.3 / xb669.2), never a whole-repo one: every edge the graph holds IS
 * the pair's history.
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
 * direction test over it (bd tea-rags-mcp-xb669.8). Built once
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
    // A call-less edge stays precedent (bd tea-rags-mcp-4vj2u): the direction
    // of KNOWLEDGE is set by every reference — a query naming the records it
    // reads through the framework's finders runs no in-project call, yet it is
    // exactly what establishes query → record. Only a nested constant is no
    // reference to the target's role at all.
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

/**
 * One family's ledger and its direction test. The family BH controls is every
 * unordered role pair {A, B}, A ≠ B, holding at least one edge either way —
 * an edgeless pair has no direction to test, and a same-role pair has only
 * one. Localities pool: where an edge sits says nothing about which way it
 * points, and splitting a pair's edges by locality would only thin the
 * evidence each test reads.
 */
function familyLedger(family: string, { pairs, byLocality }: NormLedgerTally): NormLedgers {
  const q = CONVENTIONAL_FDR_Q;
  const directed = new Map<string, number>();
  for (const local of byLocality.values()) {
    for (const [key, support] of local) directed.set(key, (directed.get(key) ?? 0) + support);
  }
  const supportOf = (roleSrc: string, roleDst: string) => directed.get(`${roleSrc}\u0000${roleDst}`) ?? 0;

  const pValueOfPair = new Map<string, number>();
  let oneWayPairCount = 0;
  for (const key of directed.keys()) {
    const [roleSrc, roleDst] = key.split("\u0000");
    if (roleSrc === roleDst) continue;
    const pairKey = unorderedPairKey(roleSrc, roleDst);
    if (pValueOfPair.has(pairKey)) continue;
    pValueOfPair.set(pairKey, signTestPValue(supportOf(roleSrc, roleDst), supportOf(roleDst, roleSrc)));
  }
  const ascending = [...pValueOfPair.values()].sort((a, b) => a - b);
  const significantPairCount = benjaminiHochbergRejectionCount(ascending, ascending.length, q);
  // BH rejects every p at or below the largest p it rejected.
  const significantPValueCut = significantPairCount === 0 ? -1 : ascending[significantPairCount - 1];
  for (const pairKey of pValueOfPair.keys()) {
    const [a, b] = pairKey.split("\u0000");
    const significant = (pValueOfPair.get(pairKey) ?? 1) <= significantPValueCut;
    if (significant && (supportOf(a, b) === 0 || supportOf(b, a) === 0)) oneWayPairCount++;
  }

  const significance: DependencyNormsSignificance = {
    method: "directionInversion",
    q,
    familySize: ascending.length,
    significantPairCount,
    oneWayPairCount,
  };
  const testDirection = (roleSrc: string, roleDst: string): NormDirectionTest => {
    const support = supportOf(roleSrc, roleDst);
    if (roleSrc === roleDst) return { support, reverseSupport: support, pValue: 1, significant: false };
    const pValue = pValueOfPair.get(unorderedPairKey(roleSrc, roleDst)) ?? 1;
    return {
      support,
      reverseSupport: supportOf(roleDst, roleSrc),
      pValue,
      significant: pValue <= significantPValueCut,
    };
  };
  return { family, pairs, byLocality, significance, testDirection, pairCount: pairs.size };
}

/** The pair's key whichever way it is read — code-point order of the two roles. */
function unorderedPairKey(roleA: string, roleB: string): string {
  return compareCodePoints(roleA, roleB) <= 0 ? `${roleA}\u0000${roleB}` : `${roleB}\u0000${roleA}`;
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
 * Why a same-family typed edge carries no verdict. `constantReference` is no
 * role edge at all — never judged, never precedent. `uncalled` and
 * `frameworkRouted` ARE precedent (see `buildNormLedgers`) but never a
 * finding: an inversion is a layering mistake only when the minority edge
 * runs the target's own logic. `displacedRole` is precedent too: an endpoint's
 * role is read where that role does not live (bd tea-rags-mcp-4vj2u), so the
 * edge says nothing about the layer the role names.
 */
type NormEdgeExclusion = "constantReference" | "uncalled" | "frameworkRouted" | "displacedRole";

/**
 * Relative slack when comparing the framework-routed part of an edge's call
 * weight with the whole: both are float sums of the same confidences, so
 * "every call routed" may differ from equality in the last bits.
 */
const CALL_WEIGHT_RELATIVE_EPSILON = 1e-9;

/**
 * The report walk's exclusion test. The edge's own evidence is named first — a
 * nested constant before a missing call before a framework route — and a
 * displaced endpoint role last, so the edge-level counts do not depend on the
 * role layer.
 */
function edgeExclusionResolver(input: DependencyNormsInput) {
  const isConstantReference = constantReferenceTest(input);
  return (
    edge: FileDependencyGraph["edges"][number],
    sourceRole: DependencyNormFileRole,
    targetRole: DependencyNormFileRole,
  ): NormEdgeExclusion | undefined => {
    if (isConstantReference(edge)) return "constantReference";
    // bd tea-rags-mcp-4vj2u: no resolved call — the source names the target,
    // it never runs the target's logic (a factory `.new`, a subtype registry,
    // an initializer's config). Measured on the xb669.8 gold set: 13 FALSE,
    // 0 TRUE among the call-less MISFITs.
    if (edge.callWeight <= 0) return "uncalled";
    // bd tea-rags-mcp-4vj2u: every call went through a framework's interface
    // (`Worker.perform_async` routed to `Worker#perform`) — the source knows
    // the target's framework contract, not its logic.
    const routed = edge.frameworkRoutedCallWeight ?? 0;
    if (routed >= edge.callWeight * (1 - CALL_WEIGHT_RELATIVE_EPSILON)) return "frameworkRouted";
    if (sourceRole.displaced !== undefined || targetRole.displaced !== undefined) return "displacedRole";
    return undefined;
  };
}

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

/**
 * The write-time verdict (bd tea-rags-mcp-23iii): "I am about to add this
 * edge — does the project do that?" Against the established direction it is a
 * MISFIT, even as the first such edge; along any written direction it
 * CONFORMS; a direction nobody wrote in a pair with no established direction
 * has no pattern to judge against (`insufficientSupport` — diff time's
 * NEW_PATTERN, xb669.3). Locality does not enter: the direction test pools it.
 */
export function judgePlannedEdge(ledgers: NormLedgers, planned: NormPlannedEdge): PlannedEdgeVerdict {
  const { roleSrc, roleDst } = planned;
  const test = ledgers.testDirection(roleSrc, roleDst);
  const evidence = { pairSupport: test.support, pValue: test.pValue };
  if (test.significant && test.support < test.reverseSupport) {
    return {
      kind: "misfit",
      ...evidence,
      establishedDirection: { roleSrc: roleDst, roleDst: roleSrc, support: test.reverseSupport },
    };
  }
  return { kind: test.support > 0 ? "conforms" : "insufficientSupport", ...evidence };
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
  const exclusionOf = edgeExclusionResolver(input);

  const findings: DependencyNormFinding[] = [];
  let crossLanguageEdgeCount = 0;
  let constantReferenceEdgeCount = 0;
  let uncalledEdgeCount = 0;
  let frameworkRoutedEdgeCount = 0;
  let displacedRoleEdgeCount = 0;
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
    // bd tea-rags-mcp-xb669.6 / 4vj2u: a nested constant or a call-less
    // reference is no role edge — counted, never judged.
    const exclusion = exclusionOf(edge, sourceRole, targetRole);
    if (exclusion !== undefined) {
      if (exclusion === "constantReference") constantReferenceEdgeCount++;
      else if (exclusion === "uncalled") uncalledEdgeCount++;
      else if (exclusion === "frameworkRouted") frameworkRoutedEdgeCount++;
      else displacedRoleEdgeCount++;
      continue;
    }
    const ledgers = book.forLanguage(family);
    const locality = localityOf(edge.sourceRelPath, edge.targetRelPath);
    const verdict = judgePlannedEdge(ledgers, {
      roleSrc: sourceRole.role,
      roleDst: targetRole.role,
      locality,
    });
    // Every walked edge is written, so its direction's support is ≥ 1: the
    // verdict is a MISFIT or CONFORMS, never `insufficientSupport`.
    if (verdict.kind !== "misfit" || verdict.establishedDirection === undefined) continue;
    findings.push(
      finding(
        family,
        edge,
        { roleSrc: sourceRole.role, roleDst: targetRole.role, locality },
        verdict,
        verdict.establishedDirection,
      ),
    );
  }

  findings.sort(
    (a, b) =>
      b.callWeight - a.callWeight ||
      compareCodePoints(a.sourceRelPath, b.sourceRelPath) ||
      compareCodePoints(a.targetRelPath, b.targetRelPath),
  );

  // bd tea-rags-mcp-mv8yv: the pattern scopes the FINDINGS by source, the way
  // every other detector scopes — ledgers, supports and the test stay
  // whole-graph. Dropped findings are counted, never lost silently.
  const inScope = compilePathPatternMatcher(input.sourcePathPattern);
  const scopedFindings = inScope ? findings.filter((f) => inScope(f.sourceRelPath)) : findings;

  const summary: DependencyNormsSummary = {
    roleFileCount: [...new Set([...fileRoles].filter(([, r]) => r.strong).map(([p]) => p))].length,
    weakRoleFileCount,
    ioShapeRoleFileCount,
    untypedFileCount,
    typedEdgeCount,
    judgedEdgeCount:
      typedEdgeCount -
      crossLanguageEdgeCount -
      constantReferenceEdgeCount -
      uncalledEdgeCount -
      frameworkRoutedEdgeCount -
      displacedRoleEdgeCount,
    violationCount: scopedFindings.length,
    pairCount: [...book.families.values()].reduce((sum, ledger) => sum + ledger.pairCount, 0),
    ...(inScope ? { outOfScopeFindingCount: findings.length - scopedFindings.length } : {}),
    excluded: {
      crossLanguageEdgeCount,
      constantReferenceEdgeCount,
      uncalledEdgeCount,
      frameworkRoutedEdgeCount,
      displacedRoleEdgeCount,
    },
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
  { pairSupport, pValue }: PlannedEdgeVerdict,
  establishedDirection: DependencyNormEstablishedDirection,
): DependencyNormFinding {
  return {
    kind: "misfit",
    family,
    sourceRelPath: edge.sourceRelPath,
    targetRelPath: edge.targetRelPath,
    roleSrc,
    roleDst,
    locality,
    callWeight: edge.callWeight,
    pairSupport,
    pValue,
    establishedDirection: { ...establishedDirection },
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
