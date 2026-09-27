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

type ExclusionReason = keyof SilentCouplingExclusionCounts;

interface Candidate {
  edge: TemporalCochangeEdgeWithLinkage;
  strength: number;
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
 * VIOLATION when either endpoint is in scope.
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
  const candidates: Candidate[] = [];
  for (const edge of graph.edges) {
    const reason = exclusionReason(edge, symbolCounts, options.isDocumentation);
    if (reason) {
      excluded[reason]++;
      continue;
    }
    candidates.push({ edge, strength: cochangeStrength(edge) });
  }

  const policy = resolveMajorityFlooredOtsuThreshold(
    candidates.map((c) => c.strength),
    { majority: SILENT_COUPLING_STRENGTH_MAJORITY, minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION },
  );
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopePairCount: 0 }
      : undefined;

  let strongCount = 0;
  let strongLinkedCount = 0;
  const violations: SilentCouplingViolation[] = [];
  for (const { edge, strength } of candidates) {
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
    violations.push(toViolation(edge, strength, symbolCounts));
  }
  violations.sort(compareViolations);
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
    excluded,
    ...(scope ? { scope } : {}),
  };
  return { summary, violations, rootCauses };
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
