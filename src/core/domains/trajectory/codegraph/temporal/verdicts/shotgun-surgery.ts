/**
 * Shotgun surgery over the temporal co-change bundles (bd
 * tea-rags-mcp-r8hme.50): ONE change spread over N components, recurring more
 * often than chance, with nothing in the structural graph explaining why the
 * change has to touch all of them. Silent coupling's N-way sibling — silent
 * coupling judges file pairs, MERGE judges component pairs that almost always
 * move together; this judges the fan-out of a single change.
 *
 * THE UNIT is the author burst (bd tea-rags-mcp-3vg0x), the same unit the pair
 * significance gate counts: a burst's component set is the union of the
 * components its admitted bundles touched — the components one change, made by
 * one author in one sitting, had to edit. A bundle without a recorded burst is
 * its own. Only partitioned (production) files count; nothing is filtered by
 * file type or by how often a component changes.
 *
 * WIDE. A unit is wide when it spans ≥ k components. k is the codebase's own:
 * the majority-floored Otsu split over every unit's width
 * ({@link resolveMajorityFlooredOtsuThreshold}), never below
 * {@link SHOTGUN_SURGERY_MIN_WIDTH} — two components are the pair question
 * MERGE and silent coupling already answer.
 *
 * RECURRING. The tested sets are k-sets: sets of EXACTLY k components that ≥ 2
 * wide units (the build's minimum support) both touched. A set's support is the
 * units containing it.
 *
 * THE NULL is the configuration null of the pair gate lifted to sets
 * (`assessBurstCochangeSignificance`): it conditions on each component's
 * change count n_c and each unit's width w. Component c enters a unit of width
 * w with probability 1 − (1 − x_c)^w, x_c fitted so the expected change count
 * Σ_u P(c ∈ u) equals the observed n_c — degrees preserved in expectation,
 * wider changes proportionally likelier to hold c. A spread's expected support
 * is λ_S = Σ_u Π_{c∈S} P(c ∈ u); for two rare components it reduces to the pair
 * gate's n_p·n_q·Qs/M². A component in most changes has P near 1 in every wide
 * unit, so its spreads' λ absorbs their support: the conditioning IS the hub
 * correction, exactly as in the pair gate. p = Poisson upper tail; multiplicity
 * = Benjamini–Hochberg at the pair gate's q over the a-priori family C(n, k) —
 * every set of exactly k components among the n changed in ≥ 2 units, the
 * pair gate's C(|F₂|, 2) lifted to k ({@link shotgunSurgeryFamilySize}). An
 * untested member counts with p = 1. A family over every width k..widest
 * (≈ 2e21 on tea-rags's own history) would demand p < 1e-23 and admit nothing.
 *
 * MAXIMAL SPREADS. Admitted k-sets merge into the spreads reported: a k-set's
 * spread is every admitted k-set inside the components all of its supporting
 * units touched ({@link mergeIntoMaximalSpreads}), so a wider fan-out shows as
 * one spread with the k-set's support, never as C(width, k) findings.
 *
 * EXPLAINED. A spread is explained when its components form ONE structurally
 * connected group: two components are joined by a component dependency
 * (either direction) or by a specific shared neighbour — silent coupling's
 * {@link SilentCouplingNeighbourIndex} over the component graph, its
 * ln(N / fanIn) weight clearing an Otsu cut drawn over every unlinked pair's
 * heaviest neighbour (Otsu only: under the floor alone every non-universal
 * neighbour would explain). A spread whose components fall into ≥ 2 islands is
 * the violation: the change keeps reaching into parts the code never connects.
 *
 * STRENGTH is {@link cochangeStrength} over the spread's support and its
 * least- and most-changed components — the larger direction's Wilson lower
 * bound, the severity. Pure: ports in, verdicts out; no bundle membership →
 * nothing judged, never zeros posing as verdicts.
 */

import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../infra/graph/index.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import {
  benjaminiHochbergRejectionCount,
  COCHANGE_SIGNIFICANCE_FDR_Q,
  cochangeStrength,
  poissonUpperTail,
  SILENT_COUPLING_OTSU_MIN_POPULATION,
  SILENT_COUPLING_SHARED_NEIGHBOUR_WEIGHT_FLOOR,
  SilentCouplingNeighbourIndex,
} from "../boundary-diagnostics/index.js";
import { TEMPORAL_COCHANGE_MIN_SUPPORT } from "../cochange/index.js";

/** The narrowest spread judged: two components are MERGE's and silent coupling's question. */
export const SHOTGUN_SURGERY_MIN_WIDTH = 3;

/** Sample commits listed per finding, most recent bursts first. */
export const SHOTGUN_SURGERY_SAMPLE_COMMITS = 5;

/** Bisection steps fitting a component's inclusion propensity — far below double precision. */
const PROPENSITY_BISECTION_STEPS = 64;

/** A component dependency, either direction joining the two components. */
export interface ShotgunSurgeryComponentDependency {
  sourceComponent: string;
  targetComponent: string;
}

export interface ShotgunSurgeryInput {
  /** The report's component partition: which component holds each file. */
  componentOf: ReadonlyMap<RelPath, string>;
  /** The component graph's dependencies — the structural links that explain a spread. */
  componentDependencies: readonly ShotgunSurgeryComponentDependency[];
  /** The admitted bundles' file memberships, keyed by bundle id. */
  bundles: ReadonlyMap<number, readonly RelPath[]>;
  /** The author burst of each bundle; absent or missing = the bundle is its own burst. */
  bundleBursts?: ReadonlyMap<number, number>;
  /** The commit SHAs of each bundle — the sample commits' source. */
  bundleCommits?: ReadonlyMap<number, readonly string[]>;
  /** Picomatch glob: a spread is in scope when an exemplar file of one of its components matches. */
  sourcePathPattern?: string;
}

/** One recurring wide spread. */
export interface ShotgunSurgerySpread {
  /** The spread's components, code-point order. */
  components: string[];
  /** Units (author bursts) touching each component, aligned with `components`. */
  componentChanges: number[];
  /** Units whose component set contains the whole spread. */
  support: number;
  /** λ_S — the support the null predicts from the components' change counts and the units' widths. */
  expectedSupport: number;
  /** {@link cochangeStrength} over support and the least- / most-changed component. */
  strength: number;
  /** Structurally connected groups of the spread, largest first; one island = explained. */
  islands: string[][];
  /** Per component (aligned) the file the supporting units touched most. */
  exemplarFiles: RelPath[];
  /** Commits of the supporting units, most recent burst first (≤ {@link SHOTGUN_SURGERY_SAMPLE_COMMITS}). */
  sampleCommits: string[];
}

export interface ShotgunSurgerySummary {
  /** Author bursts touching ≥ 1 partitioned component. */
  unitCount: number;
  /** Units spanning ≥ `widthThreshold` components. */
  wideUnitCount: number;
  /** k — the narrowest width judged. */
  widthThreshold: number;
  /** `otsu` = the codebase's width split raised k; `floor` = {@link SHOTGUN_SURGERY_MIN_WIDTH}. */
  widthThresholdMethod: "otsu" | "floor";
  widthSeparability?: number;
  /** Observed k-sets: sets of exactly k components ≥ the build's minimum support of wide units shared — the tested sets. */
  candidateSetCount: number;
  /** C(n, k), n = components changed in ≥ 2 units — the a-priori BH family; untested members count with p = 1. */
  familySize: number;
  q: number;
  /** k-sets BH rejected at q. */
  admittedSetCount: number;
  /** Maximal spreads the admitted k-sets merge into — the judged findings before explanation. */
  spreadCount: number;
  explainedCount: number;
  violationCount: number;
  sharedNeighbourThreshold?: number;
  /** `none` = the neighbour weights allowed no Otsu cut; only direct dependencies explained. */
  sharedNeighbourThresholdMethod: "otsu" | "none";
  /** Unexplained spreads with no exemplar file matching `sourcePathPattern`; present only when scoped. */
  outOfScopeSetCount?: number;
}

export interface ShotgunSurgeryReport {
  /** Unexplained recurring wide spreads, strongest first. */
  findings: ShotgunSurgerySpread[];
  /** Spreads one structural island explains, strongest first. */
  explained: ShotgunSurgerySpread[];
  summary: ShotgunSurgerySummary;
}

/** One author burst's view of the partition. */
interface ShotgunSurgeryUnit {
  components: Set<string>;
  filesByComponent: Map<string, Set<RelPath>>;
  /** Largest bundle id — the recency order. */
  order: number;
  /** Member bundle ids, descending. */
  bundleIds: number[];
}

interface AdmittedSpread {
  components: string[];
  support: number;
  expectedSupport: number;
  supporting: ShotgunSurgeryUnit[];
}

/** Judge the history's wide changes. See the module docblock for every contract. */
export function detectShotgunSurgery(input: ShotgunSurgeryInput): ShotgunSurgeryReport {
  const units = buildUnits(input);
  const widths = units.map((unit) => unit.components.size);
  const widthPolicy = resolveMajorityFlooredOtsuThreshold(widths, {
    majority: SHOTGUN_SURGERY_MIN_WIDTH - 1,
    minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION,
  });
  const widthThreshold =
    widthPolicy.method === "otsu"
      ? Math.max(SHOTGUN_SURGERY_MIN_WIDTH, Math.ceil(widthPolicy.threshold))
      : SHOTGUN_SURGERY_MIN_WIDTH;
  const wide = units.filter((unit) => unit.components.size >= widthThreshold);

  const changes = new Map<string, number>();
  for (const unit of units) for (const c of unit.components) changes.set(c, (changes.get(c) ?? 0) + 1);
  const widthHistogram = new Map<number, number>();
  for (const width of widths) widthHistogram.set(width, (widthHistogram.get(width) ?? 0) + 1);

  const changedTwice = [...changes.values()].filter((n) => n >= 2).length;
  const familySize = shotgunSurgeryFamilySize(changedTwice, widthThreshold);

  const propensity = new PropensityModel(changes, widthHistogram);
  const tested = recurringKSets(wide, widthThreshold).map(({ components, unitIndices }) => {
    const expectedSupport = propensity.expectedSupport(components);
    return {
      components,
      unitIndices,
      p: poissonUpperTail(unitIndices.length, expectedSupport),
    };
  });
  tested.sort((a, b) => a.p - b.p || compareKeys(a.components, b.components));
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((t) => t.p),
    familySize,
  );
  const admitted = tested.slice(0, rejected);
  const closed: AdmittedSpread[] = mergeIntoMaximalSpreads(admitted, wide).map(({ components, unitIndices }) => ({
    components,
    support: unitIndices.length,
    expectedSupport: propensity.expectedSupport(components),
    supporting: unitIndices.map((index) => wide[index]),
  }));

  const structure = new ShotgunSurgeryStructure(input.componentDependencies, input.componentOf);
  const islandsOf = structure.islandResolver(closed.map((spread) => spread.components));
  const inScope = compilePathPatternMatcher(input.sourcePathPattern);
  let outOfScopeSetCount = 0;
  const findings: ShotgunSurgerySpread[] = [];
  const explained: ShotgunSurgerySpread[] = [];
  for (const spread of closed) {
    const shaped = shapeSpread(spread, changes, islandsOf.islands(spread.components), input.bundleCommits);
    if (shaped.islands.length <= 1) {
      explained.push(shaped);
      continue;
    }
    if (inScope && input.sourcePathPattern && !shaped.exemplarFiles.some((relPath) => inScope(relPath))) {
      outOfScopeSetCount++;
      continue;
    }
    findings.push(shaped);
  }
  findings.sort(compareSpreads);
  explained.sort(compareSpreads);

  return {
    findings,
    explained,
    summary: {
      unitCount: units.length,
      wideUnitCount: wide.length,
      widthThreshold,
      widthThresholdMethod: widthPolicy.method === "otsu" ? "otsu" : "floor",
      ...(widthPolicy.separability === undefined ? {} : { widthSeparability: widthPolicy.separability }),
      candidateSetCount: tested.length,
      familySize,
      q: COCHANGE_SIGNIFICANCE_FDR_Q,
      admittedSetCount: admitted.length,
      spreadCount: closed.length,
      explainedCount: explained.length,
      violationCount: findings.length,
      ...(islandsOf.neighbourThreshold === undefined
        ? { sharedNeighbourThresholdMethod: "none" as const }
        : { sharedNeighbourThreshold: islandsOf.neighbourThreshold, sharedNeighbourThresholdMethod: "otsu" as const }),
      ...(input.sourcePathPattern ? { outOfScopeSetCount } : {}),
    },
  };
}

/** Bundles grouped into author bursts, each reduced to the partitioned components it touched. */
function buildUnits(input: ShotgunSurgeryInput): ShotgunSurgeryUnit[] {
  const byBurst = new Map<string, ShotgunSurgeryUnit>();
  for (const [bundleId, files] of input.bundles) {
    const burst = input.bundleBursts?.get(bundleId);
    const key = burst === undefined ? `bundle:${bundleId}` : `burst:${burst}`;
    let unit = byBurst.get(key);
    if (!unit) {
      unit = { components: new Set(), filesByComponent: new Map(), order: bundleId, bundleIds: [] };
      byBurst.set(key, unit);
    }
    unit.order = Math.max(unit.order, bundleId);
    unit.bundleIds.push(bundleId);
    for (const relPath of files) {
      const component = input.componentOf.get(relPath);
      if (component === undefined) continue;
      unit.components.add(component);
      const set = unit.filesByComponent.get(component);
      if (set) set.add(relPath);
      else unit.filesByComponent.set(component, new Set([relPath]));
    }
  }
  const units = [...byBurst.values()].filter((unit) => unit.components.size > 0);
  for (const unit of units) unit.bundleIds.sort((a, b) => b - a);
  return units;
}

/** A set of components with the (ascending) indices of the wide units containing all of it. */
interface ShotgunSurgeryUnitSet {
  components: string[];
  unitIndices: number[];
}

/**
 * Every set of exactly `k` components at least
 * {@link TEMPORAL_COCHANGE_MIN_SUPPORT} wide units share, with those units.
 * Depth-first over code-point-ordered components, intersecting the units'
 * index lists as it extends a prefix and abandoning a prefix the moment fewer
 * than the minimum support still contain it — so the walk visits only the
 * subsets that recur, never the C(n, k) family itself. A set shared by fewer
 * units is untested and counts in the family with p = 1, as an unobserved
 * pair does in the pair gate.
 */
function recurringKSets(wide: readonly ShotgunSurgeryUnit[], k: number): ShotgunSurgeryUnitSet[] {
  const postings = new Map<string, number[]>();
  wide.forEach((unit, index) => {
    for (const c of unit.components) {
      const list = postings.get(c);
      if (list) list.push(index);
      else postings.set(c, [index]);
    }
  });
  const items = [...postings]
    .filter(([, list]) => list.length >= TEMPORAL_COCHANGE_MIN_SUPPORT)
    .sort(([a], [b]) => compareCodePoints(a, b));
  const sets: ShotgunSurgeryUnitSet[] = [];
  const prefix: string[] = [];
  const extend = (start: number, unitIndices: readonly number[] | undefined): void => {
    for (let i = start; i <= items.length - (k - prefix.length); i++) {
      const [component, list] = items[i];
      const shared = unitIndices === undefined ? list : intersectSorted(unitIndices, list);
      if (shared.length < TEMPORAL_COCHANGE_MIN_SUPPORT) continue;
      prefix.push(component);
      if (prefix.length === k) sets.push({ components: [...prefix], unitIndices: [...shared] });
      else extend(i + 1, shared);
      prefix.pop();
    }
  };
  if (k > 0) extend(0, undefined);
  return sets;
}

/** Intersection of two ascending index lists. */
function intersectSorted(a: readonly number[], b: readonly number[]): number[] {
  const common: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      common.push(a[i]);
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  return common;
}

/**
 * Admitted k-sets merged into maximal spreads. A k-set's spread is every
 * admitted k-set lying inside the components ALL of its supporting units
 * touched — the closure of its recurrences. The spread is thereby a set-level
 * fact: every one of its components was edited by every change that made the
 * k-set recur, so its support is exactly the k-set's, and k-sets recurring in
 * the same changes collapse into one spread. Two k-sets recurring in different
 * changes stay apart even when they share components: their union is reported
 * only if changes touched the whole of it. Restricting the closure to admitted
 * k-sets keeps a component the null explains — one in nearly every change —
 * out of a spread it was never significant in.
 */
function mergeIntoMaximalSpreads(
  admitted: readonly ShotgunSurgeryUnitSet[],
  wide: readonly ShotgunSurgeryUnit[],
): ShotgunSurgeryUnitSet[] {
  const byRecurrence = new Map<string, number[]>();
  for (const { unitIndices } of admitted) byRecurrence.set(unitIndices.join(","), unitIndices);
  const spreads: ShotgunSurgeryUnitSet[] = [];
  for (const unitIndices of byRecurrence.values()) {
    const units = unitIndices.map((index) => wide[index].components);
    const members = new Set<string>();
    for (const { components } of admitted) {
      if (components.every((c) => units.every((unit) => unit.has(c)))) for (const c of components) members.add(c);
    }
    spreads.push({ components: [...members].sort(compareCodePoints), unitIndices });
  }
  return spreads.sort((a, b) => compareKeys(a.components, b.components));
}

/**
 * C(n, k): every set of exactly k components among the n changed in ≥ 2
 * units — the a-priori family, the pair gate's C(|F₂|, 2) lifted to k. Clamped
 * to the largest finite double.
 */
export function shotgunSurgeryFamilySize(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  let binomial = 1;
  for (let i = 0; i < k; i++) binomial = (binomial * (n - i)) / (i + 1);
  return Math.min(Math.round(binomial), Number.MAX_VALUE);
}

/**
 * The fitted-propensity null: x_c with Σ_w count_w·(1 − (1 − x_c)^w) = n_c,
 * solved by bisection on [0, 1] — the left side rises monotonically from 0 to
 * the unit count, which n_c never exceeds.
 */
class PropensityModel {
  private readonly propensity = new Map<string, number>();

  constructor(
    private readonly changes: ReadonlyMap<string, number>,
    private readonly widthHistogram: ReadonlyMap<number, number>,
  ) {}

  /** λ_S = Σ_w count_w · Π_{c∈S} (1 − (1 − x_c)^w). */
  expectedSupport(components: readonly string[]): number {
    const xs = components.map((c) => this.propensityOf(c));
    let total = 0;
    for (const [width, count] of this.widthHistogram) {
      let product = count;
      for (const x of xs) product *= inclusion(x, width);
      total += product;
    }
    return total;
  }

  private propensityOf(component: string): number {
    const cached = this.propensity.get(component);
    if (cached !== undefined) return cached;
    const target = this.changes.get(component) ?? 0;
    let low = 0;
    let high = 1;
    for (let step = 0; step < PROPENSITY_BISECTION_STEPS; step++) {
      const mid = (low + high) / 2;
      let expected = 0;
      for (const [width, count] of this.widthHistogram) expected += count * inclusion(mid, width);
      if (expected < target) low = mid;
      else high = mid;
    }
    this.propensity.set(component, high);
    return high;
  }
}

/** P(c ∈ u) for propensity x and unit width w. */
function inclusion(x: number, width: number): number {
  return -Math.expm1(width * Math.log1p(-Math.min(x, 1 - Number.EPSILON)));
}

/** The structural links among components: direct dependencies and specific shared neighbours. */
class ShotgunSurgeryStructure {
  private readonly linked = new Set<string>();
  private readonly neighbours: SilentCouplingNeighbourIndex;

  constructor(dependencies: readonly ShotgunSurgeryComponentDependency[], componentOf: ReadonlyMap<RelPath, string>) {
    const componentIds = new Set(componentOf.values());
    for (const { sourceComponent, targetComponent } of dependencies) {
      componentIds.add(sourceComponent);
      componentIds.add(targetComponent);
      if (sourceComponent !== targetComponent) this.linked.add(pairKey(sourceComponent, targetComponent));
    }
    this.neighbours = new SilentCouplingNeighbourIndex(
      dependencies.map((d) => ({ sourceRelPath: d.sourceComponent, targetRelPath: d.targetComponent })),
      componentIds.size,
    );
  }

  /**
   * Draw the shared-neighbour cut over every unlinked pair of `spreads` once,
   * then resolve each spread's islands under it.
   */
  islandResolver(spreads: readonly (readonly string[])[]): {
    neighbourThreshold: number | undefined;
    islands: (components: readonly string[]) => string[][];
  } {
    const heaviest = new Map<string, number>();
    for (const components of spreads) {
      forEachPair(components, (a, b) => {
        const key = pairKey(a, b);
        if (this.linked.has(key) || heaviest.has(key)) return;
        const neighbour = this.neighbours.heaviestSharedNeighbour(a, b);
        if (neighbour) heaviest.set(key, neighbour.weight);
      });
    }
    const policy = resolveMajorityFlooredOtsuThreshold([...heaviest.values()], {
      majority: SILENT_COUPLING_SHARED_NEIGHBOUR_WEIGHT_FLOOR,
      minPopulation: SILENT_COUPLING_OTSU_MIN_POPULATION,
    });
    const joins = (a: string, b: string): boolean => {
      const key = pairKey(a, b);
      if (this.linked.has(key)) return true;
      const weight = heaviest.get(key);
      return policy.method === "otsu" && weight !== undefined && policy.admits(weight);
    };
    return {
      neighbourThreshold: policy.method === "otsu" ? policy.threshold : undefined,
      islands: (components) => {
        const parent = new Map(components.map((c) => [c, c]));
        const find = (c: string): string => {
          let root = c;
          while (parent.get(root) !== root) root = parent.get(root) ?? root;
          parent.set(c, root);
          return root;
        };
        forEachPair(components, (a, b) => {
          if (joins(a, b)) parent.set(find(a), find(b));
        });
        const groups = new Map<string, string[]>();
        for (const c of components) {
          const root = find(c);
          const group = groups.get(root);
          if (group) group.push(c);
          else groups.set(root, [c]);
        }
        return [...groups.values()]
          .map((group) => group.sort(compareCodePoints))
          .sort((x, y) => y.length - x.length || compareCodePoints(x[0], y[0]));
      },
    };
  }
}

function shapeSpread(
  spread: AdmittedSpread,
  changes: ReadonlyMap<string, number>,
  islands: string[][],
  bundleCommits: ReadonlyMap<number, readonly string[]> | undefined,
): ShotgunSurgerySpread {
  const componentChanges = spread.components.map((c) => changes.get(c) ?? 0);
  const fewest = Math.min(...componentChanges);
  const most = Math.max(...componentChanges);
  const recentFirst = [...spread.supporting].sort((a, b) => b.order - a.order);
  const sampleCommits: string[] = [];
  for (const unit of recentFirst) {
    for (const bundleId of unit.bundleIds) {
      for (const sha of bundleCommits?.get(bundleId) ?? []) {
        if (sampleCommits.length < SHOTGUN_SURGERY_SAMPLE_COMMITS && !sampleCommits.includes(sha)) {
          sampleCommits.push(sha);
        }
      }
    }
  }
  return {
    components: spread.components,
    componentChanges,
    support: spread.support,
    expectedSupport: spread.expectedSupport,
    strength: cochangeStrength({
      support: spread.support,
      confidenceAB: spread.support / fewest,
      confidenceBA: spread.support / most,
    }),
    islands,
    exemplarFiles: spread.components.map((c) => exemplarFile(spread.supporting, c)),
    sampleCommits,
  };
}

/** The component's file the supporting units touched most; ties to the smaller path. */
function exemplarFile(units: readonly ShotgunSurgeryUnit[], component: string): RelPath {
  const counts = new Map<RelPath, number>();
  for (const unit of units) {
    for (const relPath of unit.filesByComponent.get(component) ?? []) {
      counts.set(relPath, (counts.get(relPath) ?? 0) + 1);
    }
  }
  let best: RelPath = "";
  let bestCount = 0;
  for (const [relPath, count] of counts) {
    if (count > bestCount || (count === bestCount && compareCodePoints(relPath, best) < 0)) {
      best = relPath;
      bestCount = count;
    }
  }
  return best;
}

function forEachPair(items: readonly string[], visit: (a: string, b: string) => void): void {
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) visit(items[i], items[j]);
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function compareSpreads(a: ShotgunSurgerySpread, b: ShotgunSurgerySpread): number {
  return (
    b.strength - a.strength ||
    b.support - a.support ||
    b.components.length - a.components.length ||
    compareKeys(a.components, b.components)
  );
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
  return compareCodePoints(a.join("\u0000"), b.join("\u0000"));
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
