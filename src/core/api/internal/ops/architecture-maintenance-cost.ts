/**
 * Maintenance cost of an architecture violation (bd tea-rags-mcp-r8hme.20):
 * rank violations by what they cost to maintain instead of listing them as
 * peers. The precedent is DV8 / Xiao-Cai "architecture roots" — a modularity
 * violation's cost is the extra maintenance of the files that carry it.
 *
 * Report-time only: the readings are the `git.file.*` signals the index
 * payload already holds, normalised against the collection's OWN distribution
 * (a file's position among every measured file), so nothing here is tuned to
 * one codebase. The formula and the position definition are stated once, on
 * `ArchitectureFileMaintenanceCost` in the report contract.
 *
 * Comparable across families (bd tea-rags-mcp-afyku): a violation's carriers
 * are the files on the edges that MAKE it ({@link architectureViolationCarrierFiles}),
 * and its score is the empirical-Bayes shrunken mean of their cost positions
 * ({@link MaintenanceCostShrinkage}): a mean over few carriers is mostly noise
 * and is pulled toward the centre, a mean over many stands on its own, and how
 * hard "few" pulls is estimated from the spread of the violations the report
 * ranks together — no constant tuned to a corpus.
 *
 * Both report paths rank through {@link rankFamiliesByMaintenanceCost}: the
 * whole-repo `get_architecture_report` (every family of the report one
 * population) and the diff-scoped `review_changes` architecture section (that
 * review's findings one population, its own carrier reading of a
 * `DiffDetectorFinding`). A new detector family adopts the score by routing
 * its list through the same ranker.
 */

import type { RelPath } from "../../../contracts/types/codegraph.js";
import type {
  ArchitectureFileEdge,
  ArchitectureFileMaintenanceCost,
  ArchitectureMaintenanceCostTag,
  GitFileMaintenanceSignals,
} from "../../public/dto/architecture.js";

/** Every indexed file's git readings, keyed by repo-relative path; an unmeasured file is absent. */
export type GitFileMaintenanceSignalLookup = () => Promise<ReadonlyMap<RelPath, GitFileMaintenanceSignals>>;

/** One file's cost before rounding — the scoring reads the unrounded values. */
interface FileMaintenanceCostReading {
  readonly exact: number;
  /** Mid-rank position of `exact` among every measured file's cost, 0–1. */
  readonly position: number;
  readonly dto: ArchitectureFileMaintenanceCost;
}

/** The carrier statistic {@link MaintenanceCostShrinkage} reads: a mean position over `measuredFileCount` carriers. */
export interface MaintenanceCostCarrierSample {
  /** Mean cost position of the measured carriers, unrounded. */
  readonly meanPosition: number;
  readonly measuredFileCount: number;
}

/** A violation's carriers, measured — everything its cost needs except the population it is scored in. */
export interface ViolationCarrierMeasurement extends MaintenanceCostCarrierSample {
  /** Carrying files the violation names. */
  readonly fileCount: number;
  readonly hottestFile: ArchitectureFileMaintenanceCost;
}

/**
 * Each measured file's cost, every signal positioned in the collection's own
 * distribution, and the cost itself positioned among every file's cost. Built
 * once per report from one payload read.
 */
export class FileMaintenanceCostModel {
  private readonly readings = new Map<RelPath, FileMaintenanceCostReading>();

  constructor(signals: ReadonlyMap<RelPath, GitFileMaintenanceSignals>) {
    const values = [...signals.values()];
    const commitCounts = ascending(values.map((s) => s.commitCount));
    const bugFixRates = ascending(values.map((s) => s.bugFixRate));
    /** `-ageDays`, so the youngest file sits at the top like the other two. */
    const youthScores = ascending(values.map((s) => -s.ageDays));
    const costs = new Map<RelPath, { exact: number; churn: number; bugFix: number; recency: number }>();
    for (const [relPath, signal] of signals) {
      const churn = positionIn(commitCounts, signal.commitCount);
      const bugFix = positionIn(bugFixRates, signal.bugFixRate);
      const recency = positionIn(youthScores, -signal.ageDays);
      costs.set(relPath, { exact: (churn * (1 + bugFix + recency)) / 3, churn, bugFix, recency });
    }
    const sortedCosts = ascending([...costs.values()].map((c) => c.exact));
    for (const [relPath, signal] of signals) {
      const reading = costs.get(relPath);
      if (reading === undefined) continue;
      const position = midRankPositionIn(sortedCosts, reading.exact);
      this.readings.set(relPath, {
        exact: reading.exact,
        position,
        dto: {
          relPath,
          cost: round3(reading.exact),
          costPosition: round3(position),
          churn: round3(reading.churn),
          bugFix: round3(reading.bugFix),
          recency: round3(reading.recency),
          commitCount: signal.commitCount,
          bugFixRate: signal.bugFixRate,
          ageDays: signal.ageDays,
        },
      });
    }
  }

  /** The file's cost and the signals behind it; undefined for a file the git trajectory never measured. */
  fileCost(relPath: RelPath): ArchitectureFileMaintenanceCost | undefined {
    return this.readings.get(relPath)?.dto;
  }

  /**
   * A violation's carriers measured: the mean cost position of the measured
   * ones and the costliest one named. No score — that needs the population
   * the violation is ranked in. Undefined when none is measured.
   */
  costOf(carriers: readonly RelPath[]): ViolationCarrierMeasurement | undefined {
    const files = [...new Set(carriers)];
    let positionSum = 0;
    let measured = 0;
    let hottest: FileMaintenanceCostReading | undefined;
    for (const relPath of files) {
      const reading = this.readings.get(relPath);
      if (reading === undefined) continue;
      positionSum += reading.position;
      measured++;
      if (hottest === undefined || reading.exact > hottest.exact) hottest = reading;
    }
    if (hottest === undefined) return undefined;
    return {
      meanPosition: positionSum / measured,
      measuredFileCount: measured,
      fileCount: files.length,
      hottestFile: hottest.dto,
    };
  }
}

/**
 * The empirical-Bayes shrunken mean of a violation's carrier positions,
 * estimated over the population of violations ranked together.
 *
 * Model: a violation's true cost position is drawn around the null mean 0.5
 * with a between-violation variance σ²_prior; its observed mean m over n
 * carriers adds sampling noise of variance (1/12)/n — 1/12 being the variance
 * of one mid-rank position, uniform on 0…1 under the null. The posterior mean
 * under that normal–normal model is
 *
 *     score = 0.5 + (m − 0.5) · n / (n + n₀),   n₀ = (1/12) / σ²_prior,
 *
 * so n₀ is the carrier count at which a violation's own mean and the centre
 * weigh equally. σ²_prior is the method-of-moments estimate over the
 * population, centred at the null mean 0.5 — the point the score shrinks
 * toward, and the mean every file position averages to — NOT at the
 * violations' own grand mean: E[(mᵢ − 0.5)²] = σ²_prior + (1/12)/nᵢ, so
 *
 *     σ²_prior = mean((mᵢ − 0.5)²) − mean(1/(12 nᵢ)).
 *
 * A grand-mean centre measures only the spread AMONG violations: a population
 * that is hot together (means ≈ 0.75, tight) reads as no spread and collapses
 * to 0.5, though every violation sits far above the centre the score shrinks
 * toward. A fixed centre also needs no second observation, so the estimate
 * exists for a single violation.
 *
 * When that estimate is not positive — the means sit no further from the
 * centre than carrier noise alone predicts — no violation is evidenced to
 * differ from it, n₀ is infinite and every score is 0.5. The raw mean stays in
 * `meanPosition` either way.
 */
export class MaintenanceCostShrinkage {
  private constructor(
    /** n₀: the carrier count at which a violation's own mean weighs as much as the centre; infinite without spread. */
    readonly priorFileCount: number,
  ) {}

  /** The shrinkage the population's own spread around the null mean supports. */
  static over(samples: readonly MaintenanceCostCarrierSample[]): MaintenanceCostShrinkage {
    if (samples.length === 0) return new MaintenanceCostShrinkage(Number.POSITIVE_INFINITY);
    let squares = 0;
    let noiseSum = 0;
    for (const sample of samples) {
      squares += (sample.meanPosition - NULL_POSITION_MEAN) ** 2;
      noiseSum += NULL_POSITION_VARIANCE / sample.measuredFileCount;
    }
    const priorVariance = (squares - noiseSum) / samples.length;
    return new MaintenanceCostShrinkage(
      priorVariance > 0 ? NULL_POSITION_VARIANCE / priorVariance : Number.POSITIVE_INFINITY,
    );
  }

  /** The violation's shrunken mean, unrounded; 0.5 when no spread is evidenced. */
  scoreOf(sample: MaintenanceCostCarrierSample): number {
    if (this.priorFileCount === Number.POSITIVE_INFINITY) return NULL_POSITION_MEAN;
    const weight = sample.measuredFileCount / (sample.measuredFileCount + this.priorFileCount);
    return NULL_POSITION_MEAN + (sample.meanPosition - NULL_POSITION_MEAN) * weight;
  }
}

/** Mean of one mid-rank position — uniform on 0…1 — under the null. A property of the position, not a tunable. */
const NULL_POSITION_MEAN = 0.5;
/** Variance of one uniform 0…1 position under the null. A property of the position, not a tunable. */
const NULL_POSITION_VARIANCE = 1 / 12;

/**
 * How a family's list is ordered: `maintenanceCost` (the default) re-sorts it
 * costliest first; `detector` keeps the detector's own order and only tags
 * each item. A family opts out when its detector's order already ranks the
 * finding itself — shotgun surgery's family evidence (bd tea-rags-mcp-zf9yz.1),
 * where carrier cost measured no better than chance on gold (AUC 0.46).
 */
export type MaintenanceCostFamilyOrder = "maintenanceCost" | "detector";

export interface MaintenanceCostFamilyOptions {
  readonly order?: MaintenanceCostFamilyOrder;
}

/** One family's items, read for ranking: each item's carriers and its listed shape. */
export interface MaintenanceCostFamily<V extends object> {
  readonly size: number;
  readonly carriersAt: (index: number) => readonly RelPath[];
  readonly shapeAt: (index: number) => V;
  readonly order: MaintenanceCostFamilyOrder;
}

/** A family of items, its carriers read off each item, shaped for the response by `shape` (the item itself by default). */
export function maintenanceCostFamily<T extends object>(
  items: readonly T[],
  carriersOf: (item: T) => readonly RelPath[],
  shape?: undefined,
  options?: MaintenanceCostFamilyOptions,
): MaintenanceCostFamily<T>;
export function maintenanceCostFamily<T, V extends object>(
  items: readonly T[],
  carriersOf: (item: T) => readonly RelPath[],
  shape: (item: T) => V,
  options?: MaintenanceCostFamilyOptions,
): MaintenanceCostFamily<V>;
export function maintenanceCostFamily<T, V extends object>(
  items: readonly T[],
  carriersOf: (item: T) => readonly RelPath[],
  shape?: (item: T) => V,
  options?: MaintenanceCostFamilyOptions,
): MaintenanceCostFamily<V> {
  return {
    size: items.length,
    carriersAt: (index) => carriersOf(items[index]),
    // Without `shape` the overload pins T to an object type and V to T.
    shapeAt: (index) => (shape ? shape(items[index]) : (items[index] as unknown as V)),
    order: options?.order ?? "maintenanceCost",
  };
}

/**
 * Each family's items costliest first, each tagged with its
 * `maintenanceCost`, the families scored as ONE population — n₀ is estimated
 * over every measured item of every family, so a score means the same in
 * each list. Ties: more measured carriers first, then the detector's order.
 * An item whose carrying files are all unmeasured keeps no tag and sinks
 * below every measured one. A family ordered by `detector` is tagged the same
 * and counts toward n₀ the same, but keeps its own order, unmeasured items
 * where they stand. No model — the git trajectory unavailable — returns each
 * family shaped, in order.
 */
export function rankFamiliesByMaintenanceCost<V extends object>(
  families: readonly MaintenanceCostFamily<V>[],
  model: FileMaintenanceCostModel | undefined,
): (V & ArchitectureMaintenanceCostTag)[][] {
  if (model === undefined) {
    return families.map((family) => Array.from({ length: family.size }, (_, index) => family.shapeAt(index)));
  }
  const measuredFamilies = families.map((family) =>
    Array.from({ length: family.size }, (_, index) => ({ index, measured: model.costOf(family.carriersAt(index)) })),
  );
  const shrinkage = MaintenanceCostShrinkage.over(
    measuredFamilies.flatMap((entries) => entries.flatMap(({ measured }) => (measured ? [measured] : []))),
  );
  return measuredFamilies.map((entries, familyIndex) => {
    const scored = entries.map((entry) => ({
      ...entry,
      score: entry.measured ? shrinkage.scoreOf(entry.measured) : undefined,
    }));
    if (families[familyIndex].order === "maintenanceCost") {
      scored.sort((a, b) => compareScored(a, b) || a.index - b.index);
    }
    return scored.map(({ index, measured, score }) => {
      const shaped = families[familyIndex].shapeAt(index);
      if (measured === undefined || score === undefined) return shaped;
      return {
        ...shaped,
        maintenanceCost: {
          score: round3(score),
          meanPosition: round3(measured.meanPosition),
          fileCount: measured.fileCount,
          measuredFileCount: measured.measuredFileCount,
          hottestFile: measured.hottestFile,
        },
      };
    });
  });
}

/** {@link rankFamiliesByMaintenanceCost} over one list — the list is the whole population. */
export function rankByMaintenanceCost<T extends object>(
  items: readonly T[],
  carriersOf: (item: T) => readonly RelPath[],
  model: FileMaintenanceCostModel | undefined,
): (T & ArchitectureMaintenanceCostTag)[] {
  return rankFamiliesByMaintenanceCost([maintenanceCostFamily(items, carriersOf)], model)[0];
}

interface ScoredMeasurement {
  measured: ViolationCarrierMeasurement | undefined;
  score: number | undefined;
}

function compareScored(a: ScoredMeasurement, b: ScoredMeasurement): number {
  if (a.measured === undefined || b.measured === undefined || a.score === undefined || b.score === undefined) {
    return (a.measured === undefined ? 1 : 0) - (b.measured === undefined ? 1 : 0);
  }
  return b.score - a.score || b.measured.measuredFileCount - a.measured.measuredFileCount;
}

/** One component dependency with the file edges that carry it — the component graph's shape, read structurally. */
export interface ComponentDependencyCarrierEdges {
  sourceComponent: string;
  targetComponent: string;
  fileEdges: readonly ArchitectureFileEdge[];
}

/**
 * Which files carry a partition's component edges: the endpoints of every
 * file edge between two components, and each component's own files on its
 * afferent (reached from outside) or efferent (reaching outside) edges. Built
 * from the partition the detector judged, over its FULL file-edge lists — the
 * listed evidence is a capped sample.
 */
export class ComponentEdgeCarrierIndex {
  private readonly filesOfComponent = new Map<string, RelPath[]>();
  private readonly pairFiles = new Map<string, RelPath[]>();
  private readonly afferentFiles = new Map<string, Set<RelPath>>();
  private readonly efferentFiles = new Map<string, Set<RelPath>>();

  constructor(componentOf: ReadonlyMap<RelPath, string>, dependencies: readonly ComponentDependencyCarrierEdges[]) {
    for (const [relPath, component] of componentOf) pushTo(this.filesOfComponent, component, relPath);
    for (const dependency of dependencies) {
      const key = pairKey(dependency.sourceComponent, dependency.targetComponent);
      for (const edge of dependency.fileEdges) {
        pushTo(this.pairFiles, key, edge.sourceRelPath);
        pushTo(this.pairFiles, key, edge.targetRelPath);
        addTo(this.efferentFiles, dependency.sourceComponent, edge.sourceRelPath);
        addTo(this.afferentFiles, dependency.targetComponent, edge.targetRelPath);
      }
    }
  }

  /** Both endpoints of every file edge from `sourceComponent` into `targetComponent`. */
  between(sourceComponent: string, targetComponent: string): RelPath[] {
    return unique(this.pairFiles.get(pairKey(sourceComponent, targetComponent)) ?? []);
  }

  /** The component's files some other component's file depends on. */
  afferent(component: string): RelPath[] {
    return [...(this.afferentFiles.get(component) ?? [])];
  }

  /** The component's files on its afferent OR efferent edges. */
  boundary(component: string): RelPath[] {
    return unique([...this.afferent(component), ...(this.efferentFiles.get(component) ?? [])]);
  }

  /** Every file of the component. */
  filesOf(component: string): readonly RelPath[] {
    return this.filesOfComponent.get(component) ?? [];
  }
}

/** A cut edge of a knot: a component edge, with its (capped) carrying file edges. */
interface CarrierArc {
  sourceComponent: string;
  targetComponent: string;
  fileEdges?: readonly ArchitectureFileEdge[];
}

/** A parent and its nested component inside a composition cycle. */
interface CarrierNestedPair {
  parentComponent: string;
  nestedComponent: string;
}

/**
 * The fields a violation may name its carrying files by — the report
 * contract's vocabulary, which the domain findings share (a knot's arcs and a
 * composition cycle's pairs sit at the top level there, under `evidence` in
 * the listed form) — read structurally so a new shape using the same field
 * names needs no case here.
 */
export interface ArchitectureViolationCarrierFields {
  detector?: string;
  kind?: string;
  sourceRelPath?: RelPath;
  targetRelPath?: RelPath;
  relPath?: RelPath;
  partners?: readonly { relPath: RelPath }[];
  component?: string;
  components?: readonly string[];
  sourceComponent?: string;
  targetComponent?: string;
  feedbackArcSet?: readonly CarrierArc[];
  nestedPairs?: readonly CarrierNestedPair[];
  evidence?: {
    zone?: string;
    fileEdges?: readonly ArchitectureFileEdge[];
    feedbackArcSet?: readonly CarrierArc[];
    nestedPairs?: readonly CarrierNestedPair[];
    exemplarFiles?: readonly RelPath[];
  };
}

/**
 * The files carrying one violation — the files on the edges that make it:
 *
 * - a file pair, a shared endpoint and its partners, a shotgun spread's
 *   exemplar files: the files it names;
 * - a component edge (SDP, back-edge, layer skip, abstraction bypass): both
 *   endpoints of EVERY file edge from the source component into the target;
 * - a knot: the file edges of its feedback-arc set (the cut that dissolves it);
 * - a composition cycle: the file edges between each parent and its nested
 *   component, both ways;
 * - a hub: its own files on its afferent or efferent edges — the coupling
 *   both cuts measured;
 * - a zone-of-pain component: its files other components depend on — the
 *   afferent edges that make it stable are what its rigidity costs;
 * - a zone-of-uselessness component, an island: every file of it — the
 *   defect is the ABSENCE of dependents, no edge carries it.
 *
 * Where the graph holds no such edge, the listed evidence edges, then the
 * named components' files.
 */
export function architectureViolationCarrierFiles(listed: object, index: ComponentEdgeCarrierIndex): RelPath[] {
  // Read structurally: every violation shape is an object, and the fields
  // below are optional on all of them — a shape without them names no file.
  const violation = listed as ArchitectureViolationCarrierFields;
  const named = namedFiles(violation);
  if (named.length > 0) return named;
  const carriers = edgeCarrierFiles(violation, index);
  if (carriers.length > 0) return carriers;
  return unique(namedComponents(violation).flatMap((component) => index.filesOf(component)));
}

function namedFiles(violation: ArchitectureViolationCarrierFields): RelPath[] {
  const files: RelPath[] = [];
  for (const relPath of [violation.sourceRelPath, violation.targetRelPath, violation.relPath]) {
    if (relPath !== undefined) files.push(relPath);
  }
  for (const partner of violation.partners ?? []) files.push(partner.relPath);
  for (const relPath of violation.evidence?.exemplarFiles ?? []) files.push(relPath);
  return unique(files);
}

function edgeCarrierFiles(violation: ArchitectureViolationCarrierFields, index: ComponentEdgeCarrierIndex): RelPath[] {
  const arcs = violation.feedbackArcSet ?? violation.evidence?.feedbackArcSet;
  if (arcs !== undefined && arcs.length > 0) {
    return unique(
      arcs.flatMap((arc) => pairCarrierFiles(index, arc.sourceComponent, arc.targetComponent, arc.fileEdges)),
    );
  }
  const nestedPairs = violation.nestedPairs ?? violation.evidence?.nestedPairs;
  if (nestedPairs !== undefined && nestedPairs.length > 0) {
    return unique(
      nestedPairs.flatMap((pair) => [
        ...index.between(pair.parentComponent, pair.nestedComponent),
        ...index.between(pair.nestedComponent, pair.parentComponent),
      ]),
    );
  }
  if (violation.sourceComponent !== undefined && violation.targetComponent !== undefined) {
    return pairCarrierFiles(index, violation.sourceComponent, violation.targetComponent, violation.evidence?.fileEdges);
  }
  if (violation.component === undefined) return [];
  if (violation.detector === "hubLikeDependency") return index.boundary(violation.component);
  if (violation.detector === "mainSequence" && violation.evidence?.zone === "pain") {
    return index.afferent(violation.component);
  }
  return [...index.filesOf(violation.component)];
}

/** The full file edges of one component edge; the listed sample only when the graph holds none. */
function pairCarrierFiles(
  index: ComponentEdgeCarrierIndex,
  sourceComponent: string,
  targetComponent: string,
  listedEdges: readonly ArchitectureFileEdge[] | undefined,
): RelPath[] {
  const files = index.between(sourceComponent, targetComponent);
  if (files.length > 0) return files;
  return unique((listedEdges ?? []).flatMap((edge) => [edge.sourceRelPath, edge.targetRelPath]));
}

function namedComponents(violation: ArchitectureViolationCarrierFields): string[] {
  return [
    violation.component,
    violation.sourceComponent,
    violation.targetComponent,
    ...(violation.components ?? []),
  ].filter((c): c is string => c !== undefined);
}

/** The inverse of a partition's `componentOf`: each component's files. */
export function filesByComponent(componentOf: ReadonlyMap<RelPath, string>): (component: string) => readonly RelPath[] {
  const index = new Map<string, RelPath[]>();
  for (const [relPath, component] of componentOf) pushTo(index, component, relPath);
  return (component) => index.get(component) ?? [];
}

/**
 * Position of `value` in an ascending distribution: the share of values
 * strictly below it, scaled by the share strictly below the maximum — the
 * minimum reads 0, the maximum 1, ties share one position. A flat
 * distribution (every file alike) reads 0: nothing stands out.
 */
function positionIn(sorted: readonly number[], value: number): number {
  const top = countBelow(sorted, sorted[sorted.length - 1]);
  return top === 0 ? 0 : countBelow(sorted, value) / top;
}

/**
 * Mid-rank position of `value` in an ascending distribution, over 0…1: ties
 * share the mean of their ranks, so the positions of all values average
 * exactly 0.5 — the centre a random file's position is drawn around. A single
 * value, or a flat distribution, reads that centre.
 */
function midRankPositionIn(sorted: readonly number[], value: number): number {
  if (sorted.length <= 1) return 0.5;
  const below = countBelow(sorted, value);
  const tied = countBelow(sorted, value, true) - below;
  return (below + (tied - 1) / 2) / (sorted.length - 1);
}

/** How many values are strictly below `value` — or, `inclusive`, at most `value` (binary search over an ascending list). */
function countBelow(sorted: readonly number[], value: number, inclusive = false): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value || (inclusive && sorted[mid] === value)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pairKey(sourceComponent: string, targetComponent: string): string {
  return `${sourceComponent}\u0000${targetComponent}`;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function addTo<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) map.set(key, new Set([value]));
  else set.add(value);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function ascending(values: number[]): number[] {
  return values.sort((a, b) => a - b);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
