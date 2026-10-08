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
 * and its score is a percentile against a same-size null — the chance that
 * as many files drawn at random from the collection average no higher cost
 * position ({@link meanPositionPercentile}). A plain mean shrinks toward the
 * centre as the carrier set grows (variance 1/(12n)), so a 40-file component
 * and a 2-file pair never shared a scale; the percentile gives them one.
 *
 * Both report paths rank through {@link rankByMaintenanceCost}: the whole-repo
 * `get_architecture_report` and the diff-scoped `review_changes` architecture
 * section (its own carrier reading of a `DiffDetectorFinding`). A new detector
 * family adopts the score by routing its list through the same ranker.
 */

import type { RelPath } from "../../../contracts/types/codegraph.js";
import type {
  ArchitectureFileEdge,
  ArchitectureFileMaintenanceCost,
  ArchitectureMaintenanceCost,
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

/** A violation's measured cost: the ranking key and the reported DTO. */
export interface ViolationMaintenanceCostReading {
  /** P(a same-size random mean ≥ the observed one) — the smaller, the costlier; the ranking key. */
  readonly upperTail: number;
  /** The carriers' mean cost position, unrounded — the tie-break. */
  readonly meanPosition: number;
  readonly cost: ArchitectureMaintenanceCost;
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
   * A violation's cost over the files carrying it: the mean cost position of
   * the measured ones, scored as its percentile against the mean of as many
   * random collection files, and the costliest one named. Undefined when none
   * is measured.
   */
  costOf(carriers: readonly RelPath[]): ViolationMaintenanceCostReading | undefined {
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
    const meanPosition = positionSum / measured;
    const tails = irwinHallTails(meanPosition * measured, measured);
    return {
      upperTail: tails.upper,
      meanPosition,
      cost: {
        score: round3(tails.lower),
        meanPosition: round3(meanPosition),
        fileCount: files.length,
        measuredFileCount: measured,
        hottestFile: hottest.dto,
      },
    };
  }
}

/**
 * P(mean of `n` independent uniform positions ≤ `mean`): the percentile of an
 * observed mean cost position against `n` files drawn at random from the
 * collection — the Irwin–Hall CDF of `n × mean`. One file reads its own
 * position; a larger set reads further from 0.5 for the same mean.
 */
export function meanPositionPercentile(mean: number, n: number): number {
  return irwinHallTails(mean * n, n).lower;
}

/**
 * The items costliest first, each tagged with its `maintenanceCost`; an item
 * whose carrying files are all unmeasured keeps no tag and sinks below every
 * measured one. Stable: equal costs keep the detector's own order. No model —
 * the git trajectory unavailable — returns the items untouched, in order.
 */
export function rankByMaintenanceCost<T extends object>(
  items: readonly T[],
  carriersOf: (item: T) => readonly RelPath[],
  model: FileMaintenanceCostModel | undefined,
): (T & ArchitectureMaintenanceCostTag)[] {
  return rankAndShapeByMaintenanceCost(items, carriersOf, model, (item) => item);
}

/**
 * {@link rankByMaintenanceCost} over items whose carriers are read before
 * they are shaped for the response — a domain finding holding the full edge
 * lists its listed form caps. Ranked by the upper tail (the smaller, the
 * costlier — it keeps its order where the percentile rounds to 1), then the
 * mean position, then the detector's order.
 */
export function rankAndShapeByMaintenanceCost<T, V extends object>(
  items: readonly T[],
  carriersOf: (item: T) => readonly RelPath[],
  model: FileMaintenanceCostModel | undefined,
  shape: (item: T) => V,
): (V & ArchitectureMaintenanceCostTag)[] {
  if (model === undefined) return items.map(shape);
  return items
    .map((item, index) => ({ index, item, measured: model.costOf(carriersOf(item)) }))
    .sort((a, b) => compareMeasured(a.measured, b.measured) || a.index - b.index)
    .map(({ item, measured }) => {
      const shaped = shape(item);
      return measured === undefined ? shaped : { ...shaped, maintenanceCost: measured.cost };
    });
}

function compareMeasured(
  a: ViolationMaintenanceCostReading | undefined,
  b: ViolationMaintenanceCostReading | undefined,
): number {
  if (a === undefined || b === undefined) return (a === undefined ? 1 : 0) - (b === undefined ? 1 : 0);
  return a.upperTail - b.upperTail || b.meanPosition - a.meanPosition;
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
  };
}

/**
 * The files carrying one violation — the files on the edges that make it:
 *
 * - a file pair, a shared endpoint and its partners: the files it names;
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
 * Lower and upper tail of the Irwin–Hall distribution — the sum of `n`
 * independent U(0,1) — at `sum`, each computed on the side where it is the
 * smaller probability, so a far tail keeps its precision instead of
 * rounding against 1.
 */
function irwinHallTails(sum: number, n: number): { lower: number; upper: number } {
  if (sum <= 0) return { lower: 0, upper: 1 };
  if (sum >= n) return { lower: 1, upper: 0 };
  if (sum <= n / 2) {
    const lower = irwinHallSmallerTail(sum, n);
    return { lower, upper: 1 - lower };
  }
  const upper = irwinHallSmallerTail(n - sum, n);
  return { lower: 1 - upper, upper };
}

/**
 * P(U1 + … + Un ≤ t) for 0 < t ≤ n/2, exact:
 * Σ_{k=0}^{⌊t⌋} (−1)^k C(n,k) (t − k)^n / n!, each term in log space.
 *
 * Numerical-stability switch, not a tuning knob: the alternating sum cancels
 * catastrophically once its terms dwarf the result. The loop carries a
 * worst-case rounding-error bound (summation plus each term's log/exp error,
 * in units of machine epsilon); while that bound stays under √ε of the result
 * — at least half of a double's significand survives — the exact value is
 * returned. Past it (from ~40 carriers near the centre; any term that
 * overflows a double), the central-limit normal N(n/2, n/12) with its first
 * Edgeworth term is the better-conditioned reading of the same distribution.
 */
function irwinHallSmallerTail(t: number, n: number): number {
  const logFactorials = logFactorialsThrough(n);
  let sum = 0;
  let errorBound = 0;
  for (let k = 0; k < t; k++) {
    const logBase = Math.log(t - k);
    const logTerm = n * logBase - logFactorials[k] - logFactorials[n - k];
    const term = Math.exp(logTerm);
    sum += k % 2 === 0 ? term : -term;
    errorBound += term * (n * Math.abs(logBase) + logFactorials[k] + logFactorials[n - k] + k + 2);
  }
  if (Number.isFinite(errorBound) && errorBound * Number.EPSILON <= Math.sqrt(Number.EPSILON) * sum) return sum;
  return irwinHallNormalLowerTail(t, n);
}

/**
 * The normal reading of the Irwin–Hall CDF with its first Edgeworth term.
 * U(0,1) is symmetric (no skew term) with excess kurtosis −6/5, a property of
 * the uniform, so F(z) ≈ Φ(z) + φ(z)(z³ − 3z) / (20n): error O(1/n²) instead
 * of the plain normal's O(1/n) — 2e-6 against the exact CDF at n = 40.
 */
function irwinHallNormalLowerTail(t: number, n: number): number {
  const z = (t - n / 2) / Math.sqrt(n / 12);
  const density = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  return Math.max(0, standardNormalLowerTail(z) + (density * (z * z * z - 3 * z)) / (20 * n));
}

/** Φ(z) = erfc(−z/√2) / 2. */
function standardNormalLowerTail(z: number): number {
  return complementaryErrorFunction(-z / Math.SQRT2) / 2;
}

/**
 * erfc(x) by the Chebyshev fit of Press et al., Numerical Recipes §6.2
 * (`erfcc`): fractional error below 1.2e-7 everywhere, so a far tail keeps
 * its relative precision. The coefficients are the fit, not tunables.
 */
function complementaryErrorFunction(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const tail =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? tail : 2 - tail;
}

/** ln(k!) for k = 0…n, grown on demand and shared across calls. */
const LOG_FACTORIALS: number[] = [0];
function logFactorialsThrough(n: number): readonly number[] {
  for (let k = LOG_FACTORIALS.length; k <= n; k++) LOG_FACTORIALS.push(LOG_FACTORIALS[k - 1] + Math.log(k));
  return LOG_FACTORIALS;
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
