/**
 * Silent coupling (A2, bd tea-rags-mcp-b4dcz): file pairs whose history says
 * they change together while the structural graph shows nothing joining them.
 *
 * The co-change sub-graph is judged against the symbol sub-graph: a pair the
 * import / call / re-export graph links is coupling the code declares; a pair
 * it does not link, yet that changes together more reliably than chance, is
 * coupling that lives in the developers' heads — a wire protocol and its two
 * ends, a descriptor and the implementation it describes, sibling files edited
 * as a set. A pair whose consumption resolves through a chain of adopted
 * barrels counts as declared too (bd tea-rags-mcp-89k7k.27). Language-agnostic:
 * both sub-graphs are, and nothing here reads a language.
 */

import { posix } from "node:path";

import type { SilentCouplingSharedNeighbourSignificanceSummary } from "../../../../../contracts/types/architecture-report.js";
import type {
  FileDependencyEdge,
  FileDependencyGraphFile,
  RelPath,
  TemporalCochangeEdgeWithLinkage,
  TemporalCochangeGraph,
} from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../primitives/graph/index.js";
import { hypergeometricUpperTail } from "../../../../../primitives/math/index.js";
import { classify, compilePathPatternMatcher } from "../../../../../primitives/paths/index.js";
import {
  classifyDirectoryRelation,
  MODULE_ENTRY_FILE_NAMES,
  RE_EXPORT_CYCLE_PATH_CAP,
} from "../../component-geometry/index.js";
import {
  assessGraphCochangeSignificance,
  benjaminiHochbergRejectionCount,
  COCHANGE_SIGNIFICANCE_FDR_Q,
  type CochangeSignificance,
} from "./cochange-significance.js";
import type {
  SilentCouplingExclusionCounts,
  SilentCouplingOptions,
  SilentCouplingReport,
  SilentCouplingRootCause,
  SilentCouplingSharedNeighbour,
  SilentCouplingSharedNeighbourChance,
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
 * pair. The shotgun detector's Otsu split over the candidates' weights draws
 * the actual cut; this is only the point no cut may fall to.
 */
export const SILENT_COUPLING_SHARED_NEIGHBOUR_WEIGHT_FLOOR = 0;

/** Why an explained pair is not a violation — the report's reader-facing wording. */
export const SILENT_COUPLING_EXPLAINED_REASON =
  "strong unlinked pair explained by a specific shared neighbour: both files import it, one reaches the other " +
  "through it, or it consumes both, as a registry does its siblings — and sharing it is unlikely by chance " +
  "given both files' import counts (hypergeometric over the corpus's import endpoints, Benjamini–Hochberg " +
  "over every tested pair) — coupling through a shared contract, not hidden coupling";

/** The module entry files — a re-export/facade chain may run through nothing else. */
const MODULE_ENTRY_FILES: ReadonlySet<string> = new Set(Object.values(MODULE_ENTRY_FILE_NAMES).flat());

/** The file that makes its directory a module with a facade ({@link MODULE_ENTRY_FILE_NAMES}). */
function isModuleEntryFile(relPath: RelPath): boolean {
  return MODULE_ENTRY_FILES.has(relPath.slice(relPath.lastIndexOf("/") + 1));
}

/**
 * Files a release bumps alongside whatever code shipped in it (bd
 * tea-rags-mcp-s2nes): package manifests, lockfiles and version pins. Their
 * co-change with code is version history, not coupling the code hides.
 */
const VERSION_MANIFEST_FILE_NAMES: ReadonlySet<string> = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "version-pins.json",
]);

/** A Claude Code plugin's manifest — counts only inside a `.claude-plugin/` directory. */
const PLUGIN_MANIFEST_FILE_NAME = "plugin.json";

/** A version manifest: {@link VERSION_MANIFEST_FILE_NAMES}, or a `plugin.json` under `.claude-plugin/`. */
export function isVersionManifest(relPath: RelPath): boolean {
  const fileName = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (VERSION_MANIFEST_FILE_NAMES.has(fileName)) return true;
  return fileName === PLUGIN_MANIFEST_FILE_NAME && `/${relPath}`.includes("/.claude-plugin/");
}

type ExclusionReason = keyof SilentCouplingExclusionCounts;

/** The file classes whose co-change is no evidence of coupling between the pair's code. */
type CochangeEvidenceEndpointExclusion = Extract<
  ExclusionReason,
  "testEndpoints" | "generatedEndpoints" | "documentationEndpoints" | "versionManifestEndpoints"
>;

/**
 * Why a file pair's co-change says nothing about its code, or `null`: a test,
 * generated, documentation or version-manifest endpoint changes with the code
 * for its own reasons (a release bump, a regenerated client, a doc edit). The
 * one list silent coupling and the violation impact tiers (bd
 * tea-rags-mcp-r8hme.53) both exclude by.
 */
export function cochangeEvidenceEndpointExclusion(
  relPathA: RelPath,
  relPathB: RelPath,
  isDocumentation?: (relPath: RelPath) => boolean,
): CochangeEvidenceEndpointExclusion | null {
  const endpoints = [relPathA, relPathB];
  const classes = endpoints.map((p) => classify(p));
  if (classes.some((c) => c.isTest)) return "testEndpoints";
  if (classes.some((c) => c.isGenerated)) return "generatedEndpoints";
  if (isDocumentation && endpoints.some(isDocumentation)) return "documentationEndpoints";
  if (endpoints.some(isVersionManifest)) return "versionManifestEndpoints";
  return null;
}

interface Candidate {
  edge: TemporalCochangeEdgeWithLinkage;
  strength: number;
}

/**
 * Judge every stored co-change pair.
 *
 * A pair is a CANDIDATE when neither endpoint is a test, generated,
 * documentation or version-manifest file, at least one endpoint is walked by the codegraph, and the
 * co-change significance gate admits it ({@link assessGraphCochangeSignificance},
 * bd tea-rags-mcp-89k7k.1.14): its support beats the configuration null that
 * conditions on both files' change counts, under BH over the a-priori family —
 * so a key-addressed hub's pairs (a locale file, a version manifest in every
 * bundle) fall here rather than under a file-level hub cut. A graph carrying no
 * bundle membership falls back to lift above 1. A walked module that defines no symbol — a barrel, a
 * type-only or an object-literal module — is judged like any other: its
 * `import type` dependencies are file edges (bd tea-rags-mcp-r8hme.12), so a
 * missing edge is evidence there too. Its STRENGTH
 * is {@link cochangeStrength}. The threshold is drawn over every candidate's
 * strength ({@link resolveMajorityFlooredOtsuThreshold}); a candidate clearing
 * it is STRONG, and a strong candidate the structural graph does not link is a
 * VIOLATION when either endpoint is in scope — unless a SPECIFIC shared
 * neighbour explains it ({@link SilentCouplingNeighbourIndex}): given the file
 * dependency edges, a would-be violation whose shared neighbour is unlikely by
 * chance under BH ({@link explainBySharedNeighbourChance}, bd
 * tea-rags-mcp-gj45h) is reported under `explained` instead (bd
 * tea-rags-mcp-r8hme.13) — unless the pair's
 * consumption resolves through a re-export/facade chain of module entry files,
 * adopted consumption of a barrel, counted under
 * `excluded.explainedByFacadeChain` (bd tea-rags-mcp-89k7k.27).
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
    versionManifestEndpoints: 0,
    unwalkedEndpoints: 0,
    notSignificant: 0,
    explainedByFacadeChain: 0,
  };
  const significance = options.significance ?? assessGraphCochangeSignificance(graph, { kind: "full" });
  const neighbours = options.fileDependencyEdges
    ? new SilentCouplingNeighbourIndex(options.fileDependencyEdges, walkedFiles.length)
    : null;
  const candidates: Candidate[] = [];
  for (const edge of graph.edges) {
    const reason = exclusionReason(edge, symbolCounts, options.isDocumentation, significance);
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
  const unlinked: Candidate[] = [];
  for (const candidate of candidates) {
    const { edge, strength } = candidate;
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
    unlinked.push(candidate);
  }
  const explanation = neighbours ? explainBySharedNeighbourChance(unlinked, neighbours) : undefined;

  const violations: SilentCouplingViolation[] = [];
  const explained: SilentCouplingViolation[] = [];
  for (const { edge, strength } of unlinked) {
    const sharedNeighbour = explanation?.explainedBy.get(edge);
    if (sharedNeighbour) {
      explained.push({ ...toViolation(edge, strength, symbolCounts, significance), explainedBy: sharedNeighbour });
      continue;
    }
    if (
      neighbours?.resolvesThroughFacadeChain(edge.relPathA, edge.relPathB) ||
      neighbours?.resolvesThroughFacadeChain(edge.relPathB, edge.relPathA)
    ) {
      excluded.explainedByFacadeChain++;
      continue;
    }
    violations.push(toViolation(edge, strength, symbolCounts, significance));
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
            admittedBurstCount: graph.meta.admittedBurstCount,
            maxFilesPerBundle: graph.meta.maxFilesPerBundle,
            minSupport: graph.meta.minSupport,
            maxPartnersPerFile: graph.meta.maxPartnersPerFile,
            burstWindowMinutes: graph.meta.burstWindowMinutes,
            burstWindowMethod: graph.meta.burstWindowMethod,
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
    ...(explanation ? { sharedNeighbourSignificance: explanation.summary } : {}),
    explainedCount: explained.length,
    excluded,
    ...(significance ? { cochangeSignificance: significance.summary } : {}),
    ...(scope ? { scope } : {}),
  };
  return { summary, violations, explained, rootCauses };
}

/**
 * Which strong unlinked pairs a shared neighbour explains (bd
 * tea-rags-mcp-gj45h): each pair's p is the chance of sharing its least likely
 * neighbour given both files' import counts
 * ({@link SilentCouplingNeighbourIndex#leastLikelySharedNeighbour}), 1 when it
 * shares none, and Benjamini–Hochberg at the co-change gate's FDR over every
 * tested pair names the explained ones. Per pair, not one corpus-wide cut: a
 * family of siblings explained by its own registry needs no other family's
 * neighbour weights to separate from the hubs.
 */
function explainBySharedNeighbourChance(
  tested: readonly Candidate[],
  neighbours: SilentCouplingNeighbourIndex,
): {
  explainedBy: Map<TemporalCochangeEdgeWithLinkage, SilentCouplingSharedNeighbour>;
  summary: SilentCouplingSharedNeighbourSignificanceSummary;
} {
  const sharing = tested.flatMap(({ edge }) => {
    const neighbour = neighbours.leastLikelySharedNeighbour(edge.relPathA, edge.relPathB);
    return neighbour ? [{ edge, neighbour }] : [];
  });
  sharing.sort(
    (x, y) =>
      x.neighbour.chance - y.neighbour.chance ||
      compareCodePoints(x.edge.relPathA, y.edge.relPathA) ||
      compareCodePoints(x.edge.relPathB, y.edge.relPathB),
  );
  const rejected = benjaminiHochbergRejectionCount(
    sharing.map((s) => s.neighbour.chance),
    tested.length,
    COCHANGE_SIGNIFICANCE_FDR_Q,
  );
  const explainedBy = new Map<TemporalCochangeEdgeWithLinkage, SilentCouplingSharedNeighbour>();
  for (const { edge, neighbour } of sharing.slice(0, rejected)) {
    explainedBy.set(edge, { relPath: neighbour.relPath, weight: neighbour.weight });
  }
  return {
    explainedBy,
    summary: {
      method: "hypergeometricChance",
      q: COCHANGE_SIGNIFICANCE_FDR_Q,
      testedPairCount: tested.length,
      explainedPairCount: rejected,
    },
  };
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
 *
 * Silent coupling reads it as CHANCE ({@link leastLikelySharedNeighbour}, bd
 * tea-rags-mcp-gj45h): how likely the pair shares C given both files' import
 * counts. A fourth arm reads the graph the other way: C explains the pair when
 * it CONSUMES both — a registry listing sibling implementers of one contract,
 * a chain assembling sibling strategies. Their co-change is a sweep over a
 * family the code declares, each sibling taking its own value; its weight is
 * the mirror IDF, ln(N / fanOut(C)). A re-export-only edge does not consume,
 * so a barrel that merely packages siblings explains nothing about why they
 * change together. The shotgun detector's island join still reads
 * {@link heaviestSharedNeighbour} under its own Otsu cut.
 */
export class SilentCouplingNeighbourIndex {
  private readonly imports = new Map<RelPath, Set<RelPath>>();
  private readonly importers = new Map<RelPath, Set<RelPath>>();
  /** source → targets its edge consumes (anything but a re-export-only edge). */
  private readonly consumes = new Map<RelPath, Set<RelPath>>();
  /** target → files whose edge into it consumes. */
  private readonly consumers = new Map<RelPath, Set<RelPath>>();
  /** Distinct import edges — the endpoints a file's imports are drawn from. */
  private readonly importEdgeCount: number;
  /** Distinct consuming edges — the endpoints of the consumer arm's draws. */
  private readonly consumingEdgeCount: number;

  constructor(
    edges: readonly Pick<
      FileDependencyEdge,
      "sourceRelPath" | "targetRelPath" | "importedExportNames" | "reexportedExportNames"
    >[],
    private readonly walkedFileCount: number,
  ) {
    for (const edge of edges) {
      const { sourceRelPath, targetRelPath } = edge;
      if (sourceRelPath === targetRelPath) continue;
      addToSetMap(this.imports, sourceRelPath, targetRelPath);
      addToSetMap(this.importers, targetRelPath, sourceRelPath);
      if (isReexportOnlyEdge(edge)) continue;
      addToSetMap(this.consumes, sourceRelPath, targetRelPath);
      addToSetMap(this.consumers, targetRelPath, sourceRelPath);
    }
    this.importEdgeCount = sumOfSetSizes(this.imports);
    this.consumingEdgeCount = sumOfSetSizes(this.consumes);
  }

  /** The heaviest neighbour of the pair; a tie goes to the smaller path, so the answer is stable. */
  heaviestSharedNeighbour(a: RelPath, b: RelPath): SilentCouplingSharedNeighbour | undefined {
    let best: SilentCouplingSharedNeighbour | undefined;
    const consider = (left: ReadonlySet<RelPath> | undefined, right: ReadonlySet<RelPath> | undefined): void => {
      for (const relPath of sharedMembers(left, right, a, b)) {
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

  /**
   * The shared neighbour the pair is least likely to share by chance, with
   * that chance; a tie goes to the smaller path. Each link is a draw without
   * replacement from the corpus's import endpoints, conditioned on the two
   * files' own import counts ({@link linkChance}); the pair's two links are
   * independent under the null, so sharing C has the product of their chances.
   */
  leastLikelySharedNeighbour(a: RelPath, b: RelPath): SilentCouplingSharedNeighbourChance | undefined {
    let best: SilentCouplingSharedNeighbourChance | undefined;
    const consider = (
      left: ReadonlySet<RelPath> | undefined,
      right: ReadonlySet<RelPath> | undefined,
      chanceOf: (relPath: RelPath) => number,
      weightOf: (relPath: RelPath) => number,
    ): void => {
      for (const relPath of sharedMembers(left, right, a, b)) {
        const chance = chanceOf(relPath);
        if (!best || chance < best.chance || (chance === best.chance && compareCodePoints(relPath, best.relPath) < 0)) {
          best = { relPath, weight: weightOf(relPath), chance };
        }
      }
    };
    const byImporters = (relPath: RelPath): number => this.weightOf(relPath);
    const byConsumes = (relPath: RelPath): number => this.consumerWeightOf(relPath);
    // both import C
    consider(
      this.imports.get(a),
      this.imports.get(b),
      (c) => this.importChance(a, c) * this.importChance(b, c),
      byImporters,
    );
    // A → C → B, and B → C → A
    consider(
      this.imports.get(a),
      this.importers.get(b),
      (c) => this.importChance(a, c) * this.importChance(c, b),
      byImporters,
    );
    consider(
      this.imports.get(b),
      this.importers.get(a),
      (c) => this.importChance(b, c) * this.importChance(c, a),
      byImporters,
    );
    // C consumes both
    consider(
      this.consumers.get(a),
      this.consumers.get(b),
      (c) => this.consumeChance(c, a) * this.consumeChance(c, b),
      byConsumes,
    );
    return best;
  }

  /** The chance `source` imports `target`: its fanOut draws, of which `target` holds fanIn endpoints. */
  private importChance(source: RelPath, target: RelPath): number {
    return linkChance(this.imports.get(source)?.size ?? 0, this.importers.get(target)?.size ?? 0, this.importEdgeCount);
  }

  /** {@link importChance} over consuming edges only — the consumer arm's graph. */
  private consumeChance(source: RelPath, target: RelPath): number {
    return linkChance(
      this.consumes.get(source)?.size ?? 0,
      this.consumers.get(target)?.size ?? 0,
      this.consumingEdgeCount,
    );
  }

  /** ln(N / fanIn); an importer count above N (an edge endpoint the walk never extracted) is clamped to weight 0. */
  private weightOf(relPath: RelPath): number {
    const fanIn = this.importers.get(relPath)?.size ?? 0;
    return fanIn > 0 ? Math.log(Math.max(this.walkedFileCount, fanIn) / fanIn) : 0;
  }

  /** ln(N / fanOut) of a common consumer, clamped to weight 0 like {@link weightOf}. */
  private consumerWeightOf(relPath: RelPath): number {
    const fanOut = this.consumes.get(relPath)?.size ?? 0;
    return fanOut > 0 ? Math.log(Math.max(this.walkedFileCount, fanOut) / fanOut) : 0;
  }

  /**
   * Does `importer`'s import of `target` resolve through a re-export/facade
   * chain — a path of module entry files ({@link isModuleEntryFile}) that ends
   * in a direct import of the target (bd tea-rags-mcp-89k7k.27)? A pair joined
   * so is ADOPTED consumption: the vocabulary reaches the importer through the
   * barrel it declares, so the co-change is explained, not hidden coupling.
   * The walk is this index's import graph again — no second resolver. Only
   * entry files may sit between (an ordinary module in the middle is a shared
   * dependency, which is the shared-neighbour check's question), and a direct
   * import is no chain: that edge is exactly the coupling the detector exists
   * to see. The path holds at most {@link RE_EXPORT_CYCLE_PATH_CAP} files —
   * consumer, barrels, target — like the facade detector's evidence path, so
   * reachability past the cap counts as absent.
   */
  resolvesThroughFacadeChain(importer: RelPath, target: RelPath): boolean {
    const visited = new Set<RelPath>([importer, target]);
    let frontier = [...(this.imports.get(importer) ?? [])].filter((next) => next !== target && isModuleEntryFile(next));
    for (let depth = 0; depth < RE_EXPORT_CYCLE_PATH_CAP - 2 && frontier.length > 0; depth++) {
      const nextFrontier: RelPath[] = [];
      for (const entry of frontier) {
        for (const next of this.imports.get(entry) ?? []) {
          if (next === target) return true;
          if (!visited.has(next) && isModuleEntryFile(next)) {
            visited.add(next);
            nextFrontier.push(next);
          }
        }
      }
      frontier = nextFrontier;
    }
    return false;
  }
}

/** An edge that only re-exports names and consumes none — packaging, not use. */
function isReexportOnlyEdge(edge: Pick<FileDependencyEdge, "importedExportNames" | "reexportedExportNames">): boolean {
  return (edge.reexportedExportNames?.length ?? 0) > 0 && (edge.importedExportNames?.length ?? 0) === 0;
}

/**
 * P(at least one of `draws` endpoints drawn without replacement from
 * `edgeCount` lands on a file holding `held` of them) — one link's chance
 * under the hypergeometric null.
 */
function linkChance(draws: number, held: number, edgeCount: number): number {
  return hypergeometricUpperTail(1, edgeCount, held, draws);
}

/** Members of both sets other than the pair's own endpoints. */
function* sharedMembers(
  left: ReadonlySet<RelPath> | undefined,
  right: ReadonlySet<RelPath> | undefined,
  a: RelPath,
  b: RelPath,
): Generator<RelPath> {
  if (!left || !right) return;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const relPath of small) if (relPath !== a && relPath !== b && large.has(relPath)) yield relPath;
}

function sumOfSetSizes(map: ReadonlyMap<RelPath, ReadonlySet<RelPath>>): number {
  let sum = 0;
  for (const set of map.values()) sum += set.size;
  return sum;
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
  significance: CochangeSignificance | undefined,
): ExclusionReason | null {
  const endpoints = [edge.relPathA, edge.relPathB];
  const fileClassExclusion = cochangeEvidenceEndpointExclusion(edge.relPathA, edge.relPathB, isDocumentation);
  if (fileClassExclusion) return fileClassExclusion;
  if (!endpoints.some((p) => symbolCounts.has(p))) return "unwalkedEndpoints";
  const admitted = significance ? significance.admits(edge.relPathA, edge.relPathB) : edge.lift > 1;
  if (!admitted) return "notSignificant";
  return null;
}

function toViolation(
  edge: TemporalCochangeEdgeWithLinkage,
  strength: number,
  symbolCounts: ReadonlyMap<RelPath, number>,
  significance: CochangeSignificance | undefined,
): SilentCouplingViolation {
  return {
    relPathA: edge.relPathA,
    relPathB: edge.relPathB,
    support: edge.support,
    confidenceAB: edge.confidenceAB,
    confidenceBA: edge.confidenceBA,
    lift: edge.lift,
    strength,
    ...(significance ? { expectedSupport: significance.expectedSupport(edge.relPathA, edge.relPathB) } : {}),
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
