/**
 * Silent coupling (A2, bd tea-rags-mcp-b4dcz): file pairs whose history says
 * they change together while the structural graph shows nothing joining them.
 *
 * The co-change sub-graph is judged against the symbol sub-graph: a pair the
 * import / call / re-export graph links is coupling the code declares; a pair
 * it does not link, yet that changes together more reliably than chance, is
 * coupling that lives in the developers' heads — a wire protocol and its two
 * ends, a descriptor and the implementation it describes, sibling files edited
 * as a set. Language-agnostic: both sub-graphs are, and nothing here reads a
 * language.
 */

import { posix } from "node:path";

import type {
  FileDependencyEdge,
  FileDependencyGraphFile,
  RelPath,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../../../../contracts/types/codegraph.js";
import { classify } from "../../../../../infra/file-classification/index.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import {
  classifyDirectoryRelation,
  resolveMajorityFlooredOtsuThreshold,
} from "../../symbols/boundary-diagnostics/index.js";
import type {
  SilentCouplingExclusionCounts,
  SilentCouplingOptions,
  SilentCouplingReport,
  SilentCouplingRootCause,
  SilentCouplingSharedNeighbour,
  SilentCouplingSummary,
  SilentCouplingViolation,
} from "./types.js";

/**
 * The floor on strength: a pair is strong only when the history is 95% sure
 * that, in at least one direction, a change to one file brings a change to the
 * other MORE OFTEN THAN NOT. Otsu's split over the codebase's candidates can
 * only raise it. Same strict-majority rule the leaking-abstraction detector
 * applies to facade adoption.
 */
export const SILENT_COUPLING_STRENGTH_MAJORITY = 0.5;

/** Smallest candidate population Otsu's split is trusted on — same as the facade detector's. */
export const SILENT_COUPLING_OTSU_MIN_POPULATION = 8;

/** z of the 95% Wilson score interval the strength is the lower bound of. */
export const SILENT_COUPLING_WILSON_Z = 1.96;

/** Silent partners a file needs to be reported as a root cause. One partner is a pair, not a pattern. */
export const SILENT_COUPLING_ROOT_CAUSE_MIN_PARTNERS = 2;

/**
 * The floor on a shared neighbour's weight: ln(N / fanIn) is 0 exactly when
 * every walked file imports the neighbour, which then says nothing about any
 * pair. Otsu's split over the candidates' weights draws the actual cut; this
 * is only the point no cut may fall to.
 */
export const SILENT_COUPLING_SHARED_NEIGHBOUR_WEIGHT_FLOOR = 0;

/** Why an explained pair is not a violation — the report's reader-facing wording. */
export const SILENT_COUPLING_EXPLAINED_REASON =
  "strong unlinked pair explained by a specific shared neighbour: both files import it, or one reaches the other " +
  "through it, and its weight ln(N / fanIn) clears Otsu's cut over every candidate's heaviest neighbour — " +
  "coupling through a shared contract, not hidden coupling";

type ExclusionReason = keyof SilentCouplingExclusionCounts;

interface Candidate {
  edge: TemporalCochangeEdgeWithLinkage;
  strength: number;
  /** The heaviest shared neighbour; absent when the endpoints share none, or no edges were given. */
  sharedNeighbour?: SilentCouplingSharedNeighbour;
}

/**
 * Judge every stored co-change pair.
 *
 * A pair is a CANDIDATE when neither endpoint is a test, generated or
 * documentation file, at least one endpoint is walked by the codegraph, and its
 * lift is above 1. A walked module that defines no symbol — a barrel, a
 * type-only or an object-literal module — is judged like any other: its
 * `import type` dependencies are file edges (bd tea-rags-mcp-r8hme.12), so a
 * missing edge is evidence there too. Its STRENGTH
 * is {@link cochangeStrength}. The threshold is drawn over every candidate's
 * strength ({@link resolveMajorityFlooredOtsuThreshold}); a candidate clearing
 * it is STRONG, and a strong candidate the structural graph does not link is a
 * VIOLATION when either endpoint is in scope — unless a SPECIFIC shared
 * neighbour explains it ({@link SilentCouplingNeighbourIndex}): given the file
 * dependency edges, each candidate's heaviest neighbour weight enters a second
 * Otsu split, and a would-be violation whose neighbour clears it is reported
 * under `explained` instead (bd tea-rags-mcp-r8hme.13).
 *
 * Diagnosis, not prescription: a violation says two files move together for a
 * reason the code does not state, not that the reason is wrong.
 */
export function detectSilentCoupling(
  graph: TemporalCochangeGraph,
  walkedFiles: readonly FileDependencyGraphFile[],
  options: SilentCouplingOptions = {},
): SilentCouplingReport {
  const symbolCounts = new Map(walkedFiles.map((f) => [f.relPath, f.symbolCount]));
  const excluded: SilentCouplingExclusionCounts = {
    testEndpoints: 0,
    generatedEndpoints: 0,
    documentationEndpoints: 0,
    unwalkedEndpoints: 0,
    nonPositiveLift: 0,
  };
  const neighbours = options.fileDependencyEdges
    ? new SilentCouplingNeighbourIndex(options.fileDependencyEdges, walkedFiles.length)
    : null;
  const candidates: Candidate[] = [];
  for (const edge of graph.edges) {
    const reason = exclusionReason(edge, symbolCounts, options.isDocumentation);
    if (reason) {
      excluded[reason]++;
      continue;
    }
    const sharedNeighbour = neighbours?.heaviestSharedNeighbour(edge.relPathA, edge.relPathB);
    candidates.push({ edge, strength: cochangeStrength(edge), ...(sharedNeighbour ? { sharedNeighbour } : {}) });
  }

  const policy = resolveMajorityFlooredOtsuThreshold(
    candidates.map((c) => c.strength),
    { majority: SILENT_COUPLING_STRENGTH_MAJORITY, minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION },
  );
  // Explanation needs a cut the corpus drew itself: under the floor alone every
  // neighbour short of universal would explain, so `majority` explains nothing.
  const neighbourPolicy = resolveMajorityFlooredOtsuThreshold(
    candidates.flatMap((c) => (c.sharedNeighbour ? [c.sharedNeighbour.weight] : [])),
    { majority: SILENT_COUPLING_SHARED_NEIGHBOUR_WEIGHT_FLOOR, minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION },
  );
  const explains = (neighbour: SilentCouplingSharedNeighbour): boolean =>
    neighbourPolicy.method === "otsu" && neighbourPolicy.admits(neighbour.weight);
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopePairCount: 0 }
      : undefined;

  let strongCount = 0;
  let strongLinkedCount = 0;
  const violations: SilentCouplingViolation[] = [];
  const explained: SilentCouplingViolation[] = [];
  for (const { edge, strength, sharedNeighbour } of candidates) {
    if (!policy.admits(strength)) continue;
    strongCount++;
    if (edge.structurallyLinked) {
      strongLinkedCount++;
      continue;
    }
    if (scope && inScope && !inScope(edge.relPathA) && !inScope(edge.relPathB)) {
      scope.outOfScopePairCount++;
      continue;
    }
    if (sharedNeighbour && explains(sharedNeighbour)) {
      explained.push({ ...toViolation(edge, strength, symbolCounts), explainedBy: sharedNeighbour });
      continue;
    }
    violations.push(toViolation(edge, strength, symbolCounts));
  }
  violations.sort(compareViolations);
  explained.sort(compareViolations);
  const rootCauses = collectRootCauses(violations);

  const summary: SilentCouplingSummary = {
    built: graph.meta !== null,
    ...(graph.meta
      ? {
          build: {
            head: graph.meta.head,
            builtAt: graph.meta.builtAt,
            windowSince: graph.meta.windowSince,
            commitCount: graph.meta.commitCount,
            admittedBundleCount: graph.meta.admittedBundleCount,
            maxFilesPerBundle: graph.meta.maxFilesPerBundle,
            minSupport: graph.meta.minSupport,
            maxPartnersPerFile: graph.meta.maxPartnersPerFile,
            sessionGapMinutes: graph.meta.sessionGapMinutes,
          },
        }
      : {}),
    pairCount: graph.edges.length,
    candidateCount: candidates.length,
    strongCount,
    strongLinkedCount,
    violationCount: violations.length,
    rootCauseCount: rootCauses.length,
    strengthThreshold: policy.threshold,
    strengthThresholdMethod: policy.method,
    ...(policy.separability === undefined ? {} : { strengthSeparability: policy.separability }),
    ...(neighbourPolicy.method === "otsu"
      ? {
          sharedNeighbourThreshold: neighbourPolicy.threshold,
          sharedNeighbourThresholdMethod: "otsu" as const,
          ...(neighbourPolicy.separability === undefined
            ? {}
            : { sharedNeighbourSeparability: neighbourPolicy.separability }),
        }
      : { sharedNeighbourThresholdMethod: "none" as const }),
    explainedCount: explained.length,
    excluded,
    ...(scope ? { scope } : {}),
  };
  return { summary, violations, explained, rootCauses };
}

/**
 * Who imports whom, read for one question: which file, if any, explains why
 * two files change together (bd tea-rags-mcp-r8hme.13). A neighbour C explains
 * the pair (A, B) when both import C, or when one imports C and C imports the
 * other. It explains it as far as it is SPECIFIC: weight(C) = ln(N / fanIn(C)),
 * N the walked files and fanIn(C) the distinct files importing C — the inverse
 * document frequency of C over importers. A wire protocol its two ends import
 * weighs ln(N/2); a kernel most files import weighs near 0, so sharing it
 * explains nothing.
 */
class SilentCouplingNeighbourIndex {
  private readonly imports = new Map<RelPath, Set<RelPath>>();
  private readonly importers = new Map<RelPath, Set<RelPath>>();

  constructor(
    edges: readonly FileDependencyEdge[],
    private readonly walkedFileCount: number,
  ) {
    for (const { sourceRelPath, targetRelPath } of edges) {
      if (sourceRelPath === targetRelPath) continue;
      addToSetMap(this.imports, sourceRelPath, targetRelPath);
      addToSetMap(this.importers, targetRelPath, sourceRelPath);
    }
  }

  /** The heaviest neighbour of the pair; a tie goes to the smaller path, so the answer is stable. */
  heaviestSharedNeighbour(a: RelPath, b: RelPath): SilentCouplingSharedNeighbour | undefined {
    let best: SilentCouplingSharedNeighbour | undefined;
    const consider = (left: ReadonlySet<RelPath> | undefined, right: ReadonlySet<RelPath> | undefined): void => {
      if (!left || !right) return;
      const [small, large] = left.size <= right.size ? [left, right] : [right, left];
      for (const relPath of small) {
        if (relPath === a || relPath === b || !large.has(relPath)) continue;
        const weight = this.weightOf(relPath);
        if (!best || weight > best.weight || (weight === best.weight && compareCodePoints(relPath, best.relPath) < 0)) {
          best = { relPath, weight };
        }
      }
    };
    consider(this.imports.get(a), this.imports.get(b)); // both import C
    consider(this.imports.get(a), this.importers.get(b)); // A → C → B
    consider(this.imports.get(b), this.importers.get(a)); // B → C → A
    return best;
  }

  /** ln(N / fanIn); an importer count above N (an edge endpoint the walk never extracted) is clamped to weight 0. */
  private weightOf(relPath: RelPath): number {
    const fanIn = this.importers.get(relPath)?.size ?? 0;
    return fanIn > 0 ? Math.log(Math.max(this.walkedFileCount, fanIn) / fanIn) : 0;
  }
}

function addToSetMap(map: Map<RelPath, Set<RelPath>>, key: RelPath, value: RelPath): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/**
 * A specifier that addresses a file relative to its importer's directory —
 * `./x`, `../x`, never a bare `.` or `..` (a directory is not a partner file).
 */
const RELATIVE_MODULE_SPECIFIER = /^\.{1,2}\//;

/**
 * Mark a co-change pair structurally linked when one endpoint's declared
 * module specifiers name the other (bd tea-rags-mcp-rbnkp).
 *
 * The structural graph holds only edges between files the codegraph walks: an
 * import of a stylesheet, a JSON module or an image is dropped at resolve time
 * on purpose (bd tea-rags-mcp-unt4v), so a `.tsx` and the `.module.css` it
 * imports read as a silent pair although the import sits in plain sight. The
 * importer's specifiers — `payload.imports`, read by the caller — restore it.
 *
 * A specifier names the partner in one of two ways, both exact:
 *   - RELATIVE (`./x.css`, `../pages/x.css`): joined onto the importer's
 *     directory, it IS the partner's path;
 *   - ROOTED (`ui-kit/Tour/Tour.module.css` under a `baseUrl` of
 *     `app/javascript`): the partner's path ends with it on a segment
 *     boundary. The root is the resolver configuration's, which this detector
 *     does not read — a suffix is that resolution with the root left open. It
 *     takes at least two segments: a bare basename could be any file of that
 *     name, and an alias head (`@/`) or package name that names no directory
 *     on the partner's path matches nothing.
 * Anything looser could hide a pair that is genuinely silent. Language-agnostic
 * like the rest of the detector: plain posix path arithmetic.
 */
export function linkImportedCochangePairs(
  graph: TemporalCochangeGraph,
  importSpecifiersByFile: ReadonlyMap<RelPath, readonly string[]>,
): TemporalCochangeGraph {
  const imports = (importer: RelPath, target: RelPath) =>
    (importSpecifiersByFile.get(importer) ?? []).some((specifier) => specifierNames(importer, specifier, target));
  return {
    ...graph,
    edges: graph.edges.map((edge) =>
      edge.structurallyLinked || !(imports(edge.relPathA, edge.relPathB) || imports(edge.relPathB, edge.relPathA))
        ? edge
        : { ...edge, structurallyLinked: true },
    ),
  };
}

/** Does `specifier`, written in `importer`, name `target`? See {@link linkImportedCochangePairs}. */
function specifierNames(importer: RelPath, specifier: string, target: RelPath): boolean {
  if (RELATIVE_MODULE_SPECIFIER.test(specifier)) {
    return posix.normalize(posix.join(posix.dirname(importer), specifier)) === target;
  }
  if (!specifier.includes("/") || specifier.startsWith("/")) return false;
  return target === specifier || target.endsWith(`/${specifier}`);
}

/**
 * The walked endpoint of every `one-walked` violation — the files whose
 * declared specifiers {@link linkImportedCochangePairs} needs, and the only
 * ones: a both-walked pair's imports are already file edges, and an unwalked
 * endpoint is not code that imports. Distinct, in violation order.
 */
export function oneWalkedViolationImporters(
  violations: readonly SilentCouplingViolation[],
  walkedFiles: readonly FileDependencyGraphFile[],
): RelPath[] {
  const walked = new Set(walkedFiles.map((f) => f.relPath));
  const importers = new Set<RelPath>();
  for (const v of violations) {
    if (v.structuralVisibility !== "one-walked") continue;
    importers.add(walked.has(v.relPathA) ? v.relPathA : v.relPathB);
  }
  return [...importers];
}

/**
 * How sure the history is that the pair moves together: the larger of the two
 * directions' Wilson lower bounds ({@link SILENT_COUPLING_WILSON_Z}) on the
 * conditional rate `support / changes(file)`. The lower bound, not the rate
 * itself, so a pair seen together 2 times out of 2 does not outrank one seen
 * 30 times out of 32. The larger direction, because coupling is asymmetric: a
 * descriptor that changes only when its implementation does is coupled even
 * though the implementation also changes on its own.
 */
export function cochangeStrength(
  edge: Pick<TemporalCochangeEdgeWithLinkage, "support" | "confidenceAB" | "confidenceBA">,
): number {
  return Math.max(
    wilsonLowerBound(edge.support, changesOf(edge.support, edge.confidenceAB)),
    wilsonLowerBound(edge.support, changesOf(edge.support, edge.confidenceBA)),
  );
}

/** The changes of one endpoint, recovered from support and P(other | endpoint). */
function changesOf(support: number, confidence: number): number {
  return confidence > 0 ? Math.max(support, Math.round(support / confidence)) : 0;
}

function wilsonLowerBound(successes: number, trials: number): number {
  if (trials <= 0) return 0;
  const z2 = SILENT_COUPLING_WILSON_Z ** 2;
  const p = successes / trials;
  const centre = p + z2 / (2 * trials);
  const margin = SILENT_COUPLING_WILSON_Z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials));
  return Math.max(0, (centre - margin) / (1 + z2 / trials));
}

function exclusionReason(
  edge: TemporalCochangeEdgeWithLinkage,
  symbolCounts: ReadonlyMap<RelPath, number>,
  isDocumentation: ((relPath: RelPath) => boolean) | undefined,
): ExclusionReason | null {
  const endpoints = [edge.relPathA, edge.relPathB];
  const classes = endpoints.map((p) => classify(p));
  if (classes.some((c) => c.isTest)) return "testEndpoints";
  if (classes.some((c) => c.isGenerated)) return "generatedEndpoints";
  if (isDocumentation && endpoints.some(isDocumentation)) return "documentationEndpoints";
  if (!endpoints.some((p) => symbolCounts.has(p))) return "unwalkedEndpoints";
  if (edge.lift <= 1) return "nonPositiveLift";
  return null;
}

function toViolation(
  edge: TemporalCochangeEdgeWithLinkage,
  strength: number,
  symbolCounts: ReadonlyMap<RelPath, number>,
): SilentCouplingViolation {
  return {
    relPathA: edge.relPathA,
    relPathB: edge.relPathB,
    support: edge.support,
    confidenceAB: edge.confidenceAB,
    confidenceBA: edge.confidenceBA,
    lift: edge.lift,
    strength,
    lastCoChangeAt: edge.lastCoChangeAt,
    sampleCommits: edge.sampleCommits,
    structuralVisibility:
      symbolCounts.has(edge.relPathA) && symbolCounts.has(edge.relPathB) ? "both-walked" : "one-walked",
    directoryRelation: classifyDirectoryRelation(edge.relPathA, edge.relPathB),
  };
}

function compareViolations(a: SilentCouplingViolation, b: SilentCouplingViolation): number {
  return (
    b.strength - a.strength ||
    b.support - a.support ||
    compareCodePoints(a.relPathA, b.relPathA) ||
    compareCodePoints(a.relPathB, b.relPathB)
  );
}

/** `violations` is already strongest first, so each file's partners come out in that order. */
function collectRootCauses(violations: readonly SilentCouplingViolation[]): SilentCouplingRootCause[] {
  const byFile = new Map<RelPath, { maxStrength: number; partners: RelPath[] }>();
  const add = (relPath: RelPath, partner: RelPath, strength: number) => {
    const entry = byFile.get(relPath) ?? { maxStrength: 0, partners: [] };
    entry.maxStrength = Math.max(entry.maxStrength, strength);
    entry.partners.push(partner);
    byFile.set(relPath, entry);
  };
  for (const v of violations) {
    add(v.relPathA, v.relPathB, v.strength);
    add(v.relPathB, v.relPathA, v.strength);
  }
  return [...byFile]
    .filter(([, e]) => e.partners.length >= SILENT_COUPLING_ROOT_CAUSE_MIN_PARTNERS)
    .map(([relPath, e]) => ({
      relPath,
      violationCount: e.partners.length,
      maxStrength: e.maxStrength,
      partners: e.partners,
    }))
    .sort(
      (a, b) =>
        b.violationCount - a.violationCount || b.maxStrength - a.maxStrength || compareCodePoints(a.relPath, b.relPath),
    );
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
