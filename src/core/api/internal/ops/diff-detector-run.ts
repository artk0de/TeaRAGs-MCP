/**
 * The diff-scoped detector judgement layer (bd tea-rags-mcp-89k7k.1.3, F2):
 * `DiffDetectorRun#run` judges what ONE working-tree change introduces — the
 * overlay edges F1 (`ReviewEdgeOverlay`) read from the tree — against the
 * facts the whole-repo `get_architecture_report` already derived. All
 * report-derived knowledge arrives as DATA through the ports below
 * (components, facades, the instability band, co-change pairs); this layer
 * JUDGES DIFFERENTLY, it never re-derives — the adoption/Otsu/band machinery
 * stays in the report the wiring slice consumes. Pure by contract: no DuckDB,
 * no Qdrant, no filesystem — the wiring (F3, review_changes) owns building
 * the ports and any shared-primitive extraction from
 * `architecture-report-ops.ts` it needs; this slice defines its own ports.
 *
 * Shapes contract: findings carry the whole-repo report's detector kinds
 * (stableDependencies, leakingAbstraction, silentCoupling, mainSequence) plus
 * the `cycles` kind the `find_cycles` substrate exposes and the diff-native
 * `facadeContract` (bd tea-rags-mcp-89k7k.1.6 — no whole-repo-report
 * counterpart: the report judges the project's facades as they STAND, while
 * this family judges what the DIFF did to a facade's re-export surface against
 * the indexed demand); `splitCandidates` joins when A5/c3v6o builds its
 * substrate. The layering map is the layering session's territory and is never
 * judged here.
 *
 * Absence of data is NEVER a violation: every judgement's absent-fact path —
 * `componentOf` undefined, `facadeOf` undefined, no co-change partners, no
 * indexed edges — is a silent skip, so one missing fact neither throws nor
 * mutes the other detectors.
 *
 * Masking contract: the overlay is the source of truth for a changed file's
 * CURRENT out-edges; the indexed graph behind `DiffDetectorGraphReader` is
 * what the BFS and the reverse-direction checks read, and the cycle BFS never
 * EXPANDS a changed file's node (its stale rows are the overlay's to replace).
 * The one deliberate read of a changed file's INDEXED out-edges is
 * leakingAbstraction's facade evidence — "the facade A already imports" is
 * the pre-diff usage the diff did not add — so the wiring serves those rows
 * for that predicate. Every per-edge detector iterates the overlay's unique
 * (source, target) pairs, so an edge pair is judged — and reported — once,
 * never again from a reverse or duplicated read.
 */

import type { ReviewEdgeOverlay } from "./review-edge-overlay.js";

/**
 * The indexed graph a detector may traverse, with the diff's own files
 * already meaningless here as traversal sources (see the masking contract
 * above).
 */
export interface DiffDetectorGraphReader {
  /** Outgoing file edges of one relPath from the INDEXED graph (excluding type-only). */
  edgesFrom: (relPath: string) => readonly { source: string; target: string }[];
  /** Incoming file edges — cycles and coupling need the reverse direction. */
  edgesTo: (relPath: string) => readonly { source: string; target: string }[];
}

/** Component/facade facts the whole-repo report already derived — consumed, never recomputed. */
export interface DiffDetectorCatalog {
  componentOf: (relPath: string) => { name: string; instability: number; distanceFromMainSequence: number } | undefined;
  /** The component's facade (undefined = no facade / not adopted). */
  facadeOf: (componentName: string) => string | undefined;
  /** Instability judged markedly greater — the report's own band comparison as a predicate. */
  isMarkedlyLessStable: (leanOn: number, leanedOn: number) => boolean;
}

/** Co-change pairs involving changed files, from the indexed temporal graph (cg_temporal). */
export interface DiffDetectorCouplingReader {
  /** Pairs (changedFile, partner) with their support, one call per changed file. */
  partnersOf: (relPath: string) => readonly { partner: string; support: number }[];
}

/**
 * The facade-contract facts (bd tea-rags-mcp-89k7k.1.6): which files ARE a
 * measured module's facade, and which indexed consumers outside that module
 * still import which names — the pre-diff DEMAND on a facade's export surface.
 * The supply side is the overlay's own (`reexportedExportNames` the tree read
 * recorded), so this port never reads the working tree. Absent port = the
 * family answers built:false, never a zero verdict.
 */
export interface DiffDetectorContractReader {
  /** The measured component whose facade this file is; undefined = not a facade. */
  facadeComponentOf: (relPath: string) => string | undefined;
  /** Distinct indexed consumers OUTSIDE the facade's component, imported names when recorded. */
  indexedConsumersOf: (facade: string) => readonly { source: string; importedNames?: string[] }[];
}

export interface DiffDetectorRunDeps {
  graph: DiffDetectorGraphReader;
  catalog: DiffDetectorCatalog;
  coupling: DiffDetectorCouplingReader;
  /** The facade-contract facts; absent = the family is unbuilt for this run. */
  contract?: DiffDetectorContractReader;
  /** BFS hop cap for cycle traces (default 8 — the report's own trace depth). */
  maxTraceHops?: number;
}

/** The change to judge: the files the diff touches, as the scope reader (F0) read them. */
export interface DiffDetectorScope {
  changedFiles: readonly string[];
}

export interface DiffDetectorFinding {
  detector:
    | "stableDependencies"
    | "leakingAbstraction"
    | "cycles"
    | "mainSequence"
    | "silentCoupling"
    | "facadeContract";
  /** What the judgement anchors on — an edge, a pair, a component delta. */
  subject: string; // e.g. "A -> B" | "a.ts ~ b.ts" | "component X"
  evidence: string[]; // trace path for cycles; the facade import for leakingAbstraction; deltas for mainSequence
  detail: string; // one sentence a reviewer reads
}

/** One detector family's verdict for the run — `splitCandidates` is built:false until A5 lands. */
export interface DiffDetectorStatus {
  detector: string;
  built: boolean;
  reason?: string;
  findingCount: number;
}

export interface DiffDetectorFindings {
  findings: readonly DiffDetectorFinding[];
  /** Per-family verdict — splitCandidates is built:false with its reason until A5 lands. */
  detectors: readonly DiffDetectorStatus[];
}

/** One overlay edge the diff adds, as every per-edge detector judges it. */
interface OverlayEdge {
  readonly source: string;
  readonly target: string;
}

/** The whole-repo report's trace depth, reused as the cycle BFS hop cap. */
const DEFAULT_MAX_TRACE_HOPS = 8;
/** Below this |deltaD| a touched component's main-sequence move reads as no move. */
const MAIN_SEQUENCE_EPSILON = 0.001;
/** The split-candidate family's standing verdict until its substrate exists. */
const SPLIT_CANDIDATES_REASON = "A5/c3v6o substrate not built";
/** The facade-contract family's verdict when no contract port was injected. */
const NO_CONTRACT_READER_REASON = "no contract reader";
/**
 * The whole-module import name (the `WHOLE_MODULE_EXPORT_NAME` precedent the
 * facade-leak classifier set): a consumer taking `*` re-imports whatever the
 * surface holds, so no single name drop can break it.
 */
const WHOLE_MODULE_EXPORT_NAME = "*";

export class DiffDetectorRun {
  private readonly graph: DiffDetectorGraphReader;
  private readonly catalog: DiffDetectorCatalog;
  private readonly coupling: DiffDetectorCouplingReader;
  private readonly contract: DiffDetectorContractReader | undefined;
  private readonly maxTraceHops: number;

  constructor(deps: DiffDetectorRunDeps) {
    this.graph = deps.graph;
    this.catalog = deps.catalog;
    this.coupling = deps.coupling;
    this.contract = deps.contract;
    this.maxTraceHops = deps.maxTraceHops ?? DEFAULT_MAX_TRACE_HOPS;
  }

  /**
   * Judge one diff: the edges its changed files add (the overlay) against the
   * indexed graph and the report-derived facts. Findings come out grouped in
   * the detectors' order, each detector's own findings in edge/scope order —
   * deterministic for a given overlay. Never throws on missing facts; see the
   * module docblock for the silence contract.
   */
  run(scope: DiffDetectorScope, overlay: ReviewEdgeOverlay): DiffDetectorFindings {
    const changed = new Set(scope.changedFiles);
    const overlayEdges = uniqueOverlayEdges(scope.changedFiles, overlay);
    const stableDependencies = this.judgeStableDependencies(overlayEdges);
    const leakingAbstraction = this.judgeLeakingAbstraction(overlayEdges);
    const cycles = this.judgeCycles(overlayEdges, changed);
    const mainSequence = this.judgeMainSequence(scope.changedFiles, overlayEdges);
    const silentCoupling = this.judgeSilentCoupling(scope.changedFiles, overlay, changed);
    const facadeContract = this.judgeFacadeContract(scope.changedFiles, overlay, changed);
    return {
      findings: Object.freeze([
        ...stableDependencies,
        ...leakingAbstraction,
        ...cycles,
        ...mainSequence,
        ...silentCoupling,
        ...facadeContract,
      ]),
      detectors: Object.freeze([
        detectorStatus("stableDependencies", stableDependencies.length),
        detectorStatus("leakingAbstraction", leakingAbstraction.length),
        detectorStatus("cycles", cycles.length),
        detectorStatus("mainSequence", mainSequence.length),
        detectorStatus("silentCoupling", silentCoupling.length),
        ...(this.contract === undefined
          ? [
              Object.freeze({
                detector: "facadeContract",
                built: false,
                reason: NO_CONTRACT_READER_REASON,
                findingCount: 0,
              }) satisfies DiffDetectorStatus,
            ]
          : [detectorStatus("facadeContract", facadeContract.length)]),
        Object.freeze({
          detector: "splitCandidates",
          built: false,
          reason: SPLIT_CANDIDATES_REASON,
          findingCount: 0,
        }) satisfies DiffDetectorStatus,
      ]),
    };
  }

  /**
   * Stable Dependencies over what the diff adds: an edge A -> B whose target
   * end is markedly less stable than its source end. Both ends must map to
   * report components — the band predicate is the report's own, injected; an
   * end without component facts is a silent skip, not a clean verdict.
   */
  private judgeStableDependencies(edges: readonly OverlayEdge[]): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of edges) {
      const sourceComponent = this.catalog.componentOf(edge.source);
      const targetComponent = this.catalog.componentOf(edge.target);
      if (sourceComponent === undefined || targetComponent === undefined) continue;
      if (!this.catalog.isMarkedlyLessStable(targetComponent.instability, sourceComponent.instability)) continue;
      findings.push({
        detector: "stableDependencies",
        subject: `${edge.source} -> ${edge.target}`,
        evidence: [
          `${edge.source} in ${sourceComponent.name}: instability ${format3(sourceComponent.instability)}`,
          `${edge.target} in ${targetComponent.name}: instability ${format3(targetComponent.instability)}`,
        ],
        detail:
          `the diff leans on the markedly-less-stable side: ${edge.target}'s component ${targetComponent.name} ` +
          `(I=${format3(targetComponent.instability)}) is markedly less stable than ${edge.source}'s ` +
          `${sourceComponent.name} (I=${format3(sourceComponent.instability)})`,
      });
    }
    return findings;
  }

  /**
   * The most diff-native leak: the diff adds A -> B internal to a component
   * whose facade A ALREADY imports (the indexed A -> facade edge is the
   * evidence — the pre-diff usage; see the masking contract in the module
   * docblock). B being the facade itself is the adoption the report wants,
   * never a finding.
   */
  private judgeLeakingAbstraction(edges: readonly OverlayEdge[]): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of edges) {
      const targetComponent = this.catalog.componentOf(edge.target);
      if (targetComponent === undefined) continue;
      const facade = this.catalog.facadeOf(targetComponent.name);
      if (facade === undefined || facade === edge.target) continue;
      const viaFacade = this.graph.edgesFrom(edge.source).some((indexed) => indexed.target === facade);
      if (!viaFacade) continue;
      findings.push({
        detector: "leakingAbstraction",
        subject: `${edge.source} -> ${edge.target}`,
        evidence: [`pre-existing ${edge.source} -> ${facade}`],
        detail:
          `the diff reached past the facade ${edge.source} already uses: ${edge.target} is internal to ` +
          `${targetComponent.name}, whose facade ${facade} ${edge.source} imports`,
      });
    }
    return findings;
  }

  /**
   * A cycle per NEW edge that closes one: BFS from the edge's target over the
   * indexed graph seeking its source, within the hop cap. Changed files'
   * nodes are never expanded (their stale rows are the overlay's to replace),
   * though the source remains reachable as the closing hop; the overlay
   * itself is never traversed. Each edge pair reports at most once — the
   * unique-pair iteration below is the dedupe.
   */
  private judgeCycles(edges: readonly OverlayEdge[], changed: ReadonlySet<string>): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    for (const edge of edges) {
      const cyclePath = this.traceBackTo(edge.target, edge.source, changed);
      if (cyclePath === undefined) continue;
      findings.push({
        detector: "cycles",
        subject: `${edge.source} -> ${edge.target}`,
        evidence: [cyclePath.join(" -> ")],
        detail:
          `the diff closes a cycle: the new edge ${edge.source} -> ${edge.target} plus the indexed path ` +
          `back to ${edge.source}`,
      });
    }
    return findings;
  }

  /**
   * BFS `from` → `goal` over indexed out-edges; returns the closed cycle path
   * `[goal, from, ..., goal]`, undefined when unreachable within the hop cap.
   */
  private traceBackTo(from: string, goal: string, changed: ReadonlySet<string>): readonly string[] | undefined {
    if (changed.has(from)) return undefined; // a changed node's stale rows are never traversed
    const visited = new Set<string>([from]);
    const queue: { node: string; path: readonly string[]; depth: number }[] = [{ node: from, path: [from], depth: 0 }];
    while (queue.length > 0) {
      const frame = queue.shift();
      if (frame === undefined) break;
      for (const indexed of this.graph.edgesFrom(frame.node)) {
        if (frame.depth + 1 > this.maxTraceHops) break; // every remaining edge of this frame is one hop too far
        if (indexed.target === goal) return [goal, ...frame.path, goal];
        if (changed.has(indexed.target) || visited.has(indexed.target)) continue;
        visited.add(indexed.target);
        queue.push({ node: indexed.target, path: [...frame.path, indexed.target], depth: frame.depth + 1 });
      }
    }
    return undefined;
  }

  /**
   * Main-sequence DELTAS for the components of changed files only — untouched
   * components never appear, and a touched component that does not move does
   * not either.
   *
   * APPROXIMATION (documented per spec; the wiring slice may replace it with
   * the report's exact recompute): an overlay edge between two DIFFERENT
   * components moves the SOURCE's component's instability up, one full step
   * per edge clamped at I=1 — the component's fan counts are not reachable
   * through these ports, so the exact I' = (Ce+k)/(Ca+Ce+k) is not computable
   * here. Abstractness A is held constant at the +D solution of
   * D = |A + I - 1| (A = 1 - I + D): which side of the main sequence the
   * component sits on is not exposed by the catalog either, and on that
   * solution the deltaD equals the I increment — the worst case (distance
   * grows), which is what a diff review wants flagged.
   */
  private judgeMainSequence(changedFiles: readonly string[], edges: readonly OverlayEdge[]): DiffDetectorFinding[] {
    const touched = new Map<string, { instability: number; distanceFromMainSequence: number }>();
    for (const relPath of changedFiles) {
      const component = this.catalog.componentOf(relPath);
      if (component === undefined || touched.has(component.name)) continue;
      touched.set(component.name, {
        instability: component.instability,
        distanceFromMainSequence: component.distanceFromMainSequence,
      });
    }
    const crossingEdges = new Map<string, string[]>();
    for (const edge of edges) {
      const sourceComponent = this.catalog.componentOf(edge.source);
      const targetComponent = this.catalog.componentOf(edge.target);
      if (sourceComponent === undefined || targetComponent === undefined) continue;
      if (sourceComponent.name === targetComponent.name || !touched.has(sourceComponent.name)) continue;
      const labels = crossingEdges.get(sourceComponent.name);
      if (labels === undefined) crossingEdges.set(sourceComponent.name, [`${edge.source} -> ${edge.target}`]);
      else labels.push(`${edge.source} -> ${edge.target}`);
    }

    const findings: DiffDetectorFinding[] = [];
    for (const [name, fact] of touched) {
      const edgesOut = crossingEdges.get(name);
      if (edgesOut === undefined) continue;
      const newInstability = Math.min(1, fact.instability + edgesOut.length);
      const instabilityDelta = newInstability - fact.instability;
      if (Math.abs(instabilityDelta) <= MAIN_SEQUENCE_EPSILON) continue;
      const abstractness = 1 - fact.instability + fact.distanceFromMainSequence;
      const newDistance = Math.abs(abstractness + newInstability - 1);
      findings.push({
        detector: "mainSequence",
        subject: name,
        evidence: [`D ${format3(fact.distanceFromMainSequence)} -> ${format3(newDistance)}`, ...edgesOut],
        detail:
          `the diff moves ${name} off its main-sequence distance: ${edgesOut.length} cross-component outgoing ` +
          `edge(s) raise instability ${format3(fact.instability)} -> ${format3(newInstability)} with abstractness held`,
      });
    }
    return findings;
  }

  /**
   * Silent coupling pairs involving a changed file: a strong co-change pair
   * the diff does not explain. A pair is explained when the overlay adds its
   * structural edge in either direction, or when one already stands in the
   * indexed graph's reverse direction (a pre-existing partner -> file edge —
   * without that check the "no structural edge" sentence below could be
   * false). Both sides in the diff is the review's own business, not a
   * finding (bd tea-rags-mcp-3kykc owns the partner-missing question).
   */
  private judgeSilentCoupling(
    changedFiles: readonly string[],
    overlay: ReviewEdgeOverlay,
    changed: ReadonlySet<string>,
  ): DiffDetectorFinding[] {
    const findings: DiffDetectorFinding[] = [];
    const reported = new Set<string>();
    for (const relPath of changedFiles) {
      for (const pair of this.coupling.partnersOf(relPath)) {
        if (changed.has(pair.partner)) continue;
        const subject = `${relPath} ~ ${pair.partner}`;
        if (reported.has(subject)) continue;
        const explainedByOverlay =
          overlay.edgesFrom(relPath).some((edge) => edge.targetRelPath === pair.partner) ||
          overlay.edgesFrom(pair.partner).some((edge) => edge.targetRelPath === relPath);
        if (explainedByOverlay) continue;
        const structurallyVisible = this.graph.edgesTo(relPath).some((indexed) => indexed.source === pair.partner);
        if (structurallyVisible) continue;
        reported.add(subject);
        findings.push({
          detector: "silentCoupling",
          subject,
          evidence: [`co-change support ${format3(pair.support)}`],
          detail:
            `strong co-change with no structural edge and the diff does not add one: ${subject} ` +
            `(support ${format3(pair.support)})`,
        });
      }
    }
    return findings;
  }

  /**
   * Facade-contract breaks: a changed file that IS a measured module's facade
   * stops re-exporting names indexed consumers outside the module still
   * import — the SUPPLY side of the export surface (the demand side, a new
   * deep import past a facade, is leakingAbstraction's). The tree's re-export
   * surface is the overlay's own recorded names; the pre-diff demand is the
   * indexed graph's. Judged only when the tree recorded a re-export surface
   * at all — "not recorded" must never read as "exports nothing" (the same
   * guard `classifyFacadeLeak`'s `facadeNamesRecorded` makes on the report
   * side). A consumer the diff also changes is skipped: its indexed row is
   * stale, the diff judges its own read.
   */
  private judgeFacadeContract(
    changedFiles: readonly string[],
    overlay: ReviewEdgeOverlay,
    changed: ReadonlySet<string>,
  ): DiffDetectorFinding[] {
    if (this.contract === undefined) return [];
    const findings: DiffDetectorFinding[] = [];
    for (const relPath of changedFiles) {
      const componentDir = this.contract.facadeComponentOf(relPath);
      if (componentDir === undefined) continue;
      const treeExposed = new Set<string>();
      let reexportsRecorded = false;
      for (const edge of overlay.edgesFrom(relPath)) {
        if (edge.reexportedExportNames === undefined) continue;
        reexportsRecorded = true;
        for (const name of edge.reexportedExportNames) treeExposed.add(name);
      }
      if (!reexportsRecorded) continue;

      const consumersByDroppedName = new Map<string, Set<string>>();
      for (const consumer of this.contract.indexedConsumersOf(relPath)) {
        if (changed.has(consumer.source)) continue;
        if (consumer.importedNames === undefined) continue;
        if (consumer.importedNames.includes(WHOLE_MODULE_EXPORT_NAME)) continue;
        for (const name of consumer.importedNames) {
          if (treeExposed.has(name)) continue;
          const sources = consumersByDroppedName.get(name);
          if (sources === undefined) consumersByDroppedName.set(name, new Set([consumer.source]));
          else sources.add(consumer.source);
        }
      }
      if (consumersByDroppedName.size === 0) continue;

      const droppedNames = [...consumersByDroppedName.keys()].sort();
      findings.push({
        detector: "facadeContract",
        subject: relPath,
        evidence: droppedNames.map((name) => {
          const sources = [...(consumersByDroppedName.get(name) ?? [])].sort();
          return `${name}: consumed by ${sources.join(", ")}`;
        }),
        detail:
          `the diff stops re-exporting names the module's consumers still import: ` +
          `${droppedNames.join(", ")} left ${relPath}'s re-export surface while indexed files outside ` +
          `${componentDir} still import them`,
      });
    }
    return findings;
  }
}

/**
 * The diff's own edges as unique (source, target) pairs: one read per changed
 * file, self-edges dropped (the overlay's builder already drops them; the
 * guard keeps the judgement total), duplicates collapsed — a scope that lists
 * a file twice judges its edges once.
 */
function uniqueOverlayEdges(changedFiles: readonly string[], overlay: ReviewEdgeOverlay): readonly OverlayEdge[] {
  const seen = new Set<string>();
  const edges: OverlayEdge[] = [];
  for (const relPath of changedFiles) {
    for (const edge of overlay.edgesFrom(relPath)) {
      if (edge.targetRelPath === relPath) continue;
      const key = `${relPath} -> ${edge.targetRelPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: relPath, target: edge.targetRelPath });
    }
  }
  return edges;
}

/** A built detector family's verdict row. */
function detectorStatus(detector: DiffDetectorFinding["detector"], findingCount: number): DiffDetectorStatus {
  return Object.freeze({ detector, built: true, findingCount });
}

/** Three decimals — the whole-repo report's evidence formatting. */
function format3(value: number): string {
  return value.toFixed(3);
}
