/**
 * Shotgun surgery over the temporal co-change bundles (bd
 * tea-rags-mcp-r8hme.50): ONE change spread over N components, recurring more
 * often than chance, with nothing in the structural graph explaining why the
 * change has to touch all of them. Silent coupling's N-way sibling — silent
 * coupling judges file pairs, MERGE judges component pairs that almost always
 * move together; this judges the fan-out of a single change.
 *
 * THE UNIT is the pair significance gate's, lifted to sets
 * (`assessBurstCochangeSignificance`, bd tea-rags-mcp-3vg0x): a k-set is
 * supported by an author BURST only when ONE logical change inside it held all
 * k components, and each burst counts at most once. A logical change is the
 * burst's commits joined by a shared task id (bd tea-rags-mcp-09c4m,
 * {@link changeUnitsByBurst}); with nothing joining them it is one commit. The
 * burst only stops a WIP spray of re-commits from counting as many changes. A
 * burst's union is never a unit — parallel agent sessions committing under one
 * author chain unrelated commits into it, so a union spread is one no single
 * change ever touched. The per-change sets ("per-commit sets" below) are the
 * changes' component sets, identical sets of one burst deduplicated (the
 * gate's distinct-pairs-per-burst). A bundle without a recorded burst is its
 * own. Only partitioned (production) files count; nothing is filtered by file
 * type or by how often a component changes.
 *
 * WIDE. A per-commit set is wide when it spans ≥ k components. k is the
 * codebase's own: the majority-floored Otsu split over every per-commit set's
 * width ({@link resolveMajorityFlooredOtsuThreshold}), never below
 * {@link SHOTGUN_SURGERY_MIN_WIDTH} — two components are the pair question
 * MERGE and silent coupling already answer.
 *
 * RECURRING. The tested sets are k-sets: sets of EXACTLY k components that
 * wide commits of ≥ 2 bursts (the build's minimum support) each held whole. A
 * set's support is the bursts with such a commit.
 *
 * THE NULL is the pair gate's configuration null lifted to sets, built from
 * the same counts. The gate takes degrees from bursts — n_f = bursts touching
 * f, M = Σ the bursts' file counts — and opportunities from commits — Qs =
 * the distinct pairs ONE commit held per burst. Here likewise: x_c is fitted so
 * Σ_b P(c ∈ b) over the bursts' widths equals n_c, the bursts touching c
 * (P(c ∈ u) = 1 − (1 − x_c)^w for a set of width w), and a spread's expected
 * support sums over the per-commit sets: λ_S = Σ_u Π_{c∈S} P(c ∈ u). For two
 * rare components it reduces to the gate's n_p·n_q·Qs/M². Summing over a
 * burst's distinct commit sets bounds the chance some commit of the burst held
 * S from above, so λ errs conservative. A component in most changes has P near
 * 1 in every wide set, so its spreads' λ absorbs their support: the
 * conditioning IS the hub correction, exactly as in the pair gate. p = Poisson upper tail; multiplicity
 * = Benjamini–Hochberg at the pair gate's q over the a-priori family C(n, k) —
 * every set of exactly k components among the n changed in ≥ 2 units, the
 * pair gate's C(|F₂|, 2) lifted to k ({@link shotgunSurgeryFamilySize}). An
 * untested member counts with p = 1. A family over every width k..widest
 * (≈ 2e21 on tea-rags's own history) would demand p < 1e-23 and admit nothing.
 *
 * MAXIMAL SPREADS. Admitted k-sets merge into the spreads reported: a k-set's
 * spread is every admitted k-set inside the components EVERY commit that held
 * it touched ({@link mergeIntoMaximalSpreads}), so a wider fan-out shows as one
 * spread with the k-set's support, never as C(width, k) findings — and every
 * supporting burst holds a commit that edited the whole spread.
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

/** Sample commits listed per finding: one per supporting burst, most recent first. */
export const SHOTGUN_SURGERY_SAMPLE_COMMITS = 5;

/** Carrier files listed per component of a finding — an output bound, never a judgement. */
export const SHOTGUN_SURGERY_CARRIER_FILES = 5;

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
  /**
   * The task ids each bundle's commit message carries (the git trajectory's
   * `extractTaskIds`), keyed by bundle id — commits of one burst naming a
   * common task are one logical change. Absent = not recorded: the change
   * units fall back to structure alone.
   */
  bundleTaskIds?: ReadonlyMap<number, readonly string[]>;
  /** Picomatch glob: a spread is in scope when an exemplar file of one of its components matches. */
  sourcePathPattern?: string;
}

/** One recurring wide spread. */
export interface ShotgunSurgerySpread {
  /** The spread's components, code-point order. */
  components: string[];
  /** Author bursts touching each component, aligned with `components`. */
  componentChanges: number[];
  /** Author bursts with a commit that held the whole spread. */
  support: number;
  /** λ_S — the support the null predicts from the components' burst counts and the commits' widths. */
  expectedSupport: number;
  /** {@link cochangeStrength} over support and the least- / most-changed component. */
  strength: number;
  /** Structurally connected groups of the spread, largest first; one island = explained. */
  islands: string[][];
  /** Per component (aligned) the file the supporting commits touched most. */
  exemplarFiles: RelPath[];
  /**
   * Per component (aligned) the files the supporting changes touched there,
   * most-touched first (≤ {@link SHOTGUN_SURGERY_CARRIER_FILES}) — what an
   * agent explaining the spread reads and searches across.
   */
  carrierFiles: RelPath[][];
  /** Commits that held the spread, one per supporting burst, most recent first (≤ {@link SHOTGUN_SURGERY_SAMPLE_COMMITS}). */
  sampleCommits: string[];
  /**
   * The logical change behind each sample commit, aligned with `sampleCommits`:
   * every commit of the burst's change that held the spread, most recent first.
   */
  sampleChanges: string[][];
}

export interface ShotgunSurgerySummary {
  /** Author bursts touching ≥ 1 partitioned component — the support unit. */
  burstCount: number;
  /** Per-commit component sets (identical sets of one burst once) — the width model's population. */
  unitCount: number;
  /** Per-commit sets spanning ≥ `widthThreshold` components. */
  wideUnitCount: number;
  /** k — the narrowest width judged. */
  widthThreshold: number;
  /** `otsu` = the codebase's width split raised k; `floor` = {@link SHOTGUN_SURGERY_MIN_WIDTH}. */
  widthThresholdMethod: "otsu" | "floor";
  widthSeparability?: number;
  /** Observed k-sets: sets of exactly k components wide commits of ≥ the build's minimum support of bursts held whole — the tested sets. */
  candidateSetCount: number;
  /** C(n, k), n = components changed in ≥ 2 bursts — the a-priori BH family; untested members count with p = 1. */
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

/** One counted unit: a distinct change-unit component set of an author burst. */
interface ShotgunSurgeryUnit {
  /** Index of the unit's author burst. */
  burst: number;
  components: Set<string>;
  filesByComponent: Map<string, Set<RelPath>>;
  /** Largest bundle id — the recency order. */
  order: number;
  /** The bundles (one commit each) of the change units with this component set, descending. */
  bundleIds: number[];
}

/** The history in the pair gate's two counts: per-commit sets, and the bursts they belong to. */
interface ShotgunSurgeryHistory {
  /** Per-commit component sets, identical sets of one burst once. */
  units: ShotgunSurgeryUnit[];
  burstCount: number;
  /** n_c — bursts with a commit touching c. */
  changes: Map<string, number>;
  /** Width → bursts touching that many components — the degrees' M. */
  burstWidths: Map<number, number>;
}

interface AdmittedSpread {
  components: string[];
  support: number;
  expectedSupport: number;
  /** The commits (per-commit sets) that held the spread. */
  supporting: ShotgunSurgeryUnit[];
}

/** Judge the history's wide changes. See the module docblock for every contract. */
export function detectShotgunSurgery(input: ShotgunSurgeryInput): ShotgunSurgeryReport {
  const { units, burstCount, changes, burstWidths } = buildHistory(input);
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

  const unitWidths = new Map<number, number>();
  for (const width of widths) unitWidths.set(width, (unitWidths.get(width) ?? 0) + 1);

  const changedTwice = [...changes.values()].filter((n) => n >= 2).length;
  const familySize = shotgunSurgeryFamilySize(changedTwice, widthThreshold);

  const propensity = new PropensityModel(changes, burstWidths, unitWidths);
  const tested = recurringKSets(wide, widthThreshold).map((set) => ({
    ...set,
    p: poissonUpperTail(set.support, propensity.expectedSupport(set.components)),
  }));
  tested.sort((a, b) => a.p - b.p || compareKeys(a.components, b.components));
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((t) => t.p),
    familySize,
  );
  const admitted = tested.slice(0, rejected);
  const closed: AdmittedSpread[] = mergeIntoMaximalSpreads(admitted, wide).map(
    ({ components, unitIndices, support }) => ({
      components,
      support,
      expectedSupport: propensity.expectedSupport(components),
      supporting: unitIndices.map((index) => wide[index]),
    }),
  );

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
      burstCount,
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

/** One change of an author burst: the partitioned files it edited and the bundles (commits) that made it. */
interface ShotgunSurgeryChangeUnit {
  filesByComponent: Map<string, Set<RelPath>>;
  bundleIds: number[];
}

/**
 * THE CHANGE-UNIT SEAM — the one place that decides what "one change" inside
 * an author burst is; support, the null's opportunities, the width model, the
 * closure and the sample commits all consume its units and their bundle ids,
 * never a bundle directly.
 *
 * A change unit is a LOGICAL change (bd tea-rags-mcp-09c4m): the connected
 * components of a burst's commits under "one change", where two commits are
 * one change when their messages name a common task id. A unit is the union
 * of its commits' files and carries all their bundle ids. Task ids are specific
 * by nature, so the join cannot chain a burst through a hub. Structure never
 * joins: a shared file or a dependency edge is no evidence of one change -
 * measured on tea-rags, joining through them chained whole bursts (provider.ts
 * sits in 144 commits) into 8-152-commit "changes" and turned 0 shotgun
 * violations into 5. Semantics (similar code across components) never joins
 * either: it only explains a reported spread, and the consuming agent judges
 * that. Without recorded task ids a unit is one commit.
 *
 * Bursts come back in first-seen order; a bundle without a recorded burst is
 * its own; a bundle touching no partitioned file is no change.
 */
function changeUnitsByBurst(input: ShotgunSurgeryInput): ShotgunSurgeryChangeUnit[][] {
  const bursts = new Map<string, ShotgunSurgeryCommit[]>();
  for (const [bundleId, files] of input.bundles) {
    const filesByComponent = new Map<string, Set<RelPath>>();
    for (const relPath of files) {
      const component = input.componentOf.get(relPath);
      if (component === undefined) continue;
      const set = filesByComponent.get(component);
      if (set) set.add(relPath);
      else filesByComponent.set(component, new Set([relPath]));
    }
    if (filesByComponent.size === 0) continue;
    const burst = input.bundleBursts?.get(bundleId);
    const burstKey = burst === undefined ? `bundle:${bundleId}` : `burst:${burst}`;
    const commit = { bundleId, filesByComponent, taskIds: input.bundleTaskIds?.get(bundleId) ?? [] };
    const members = bursts.get(burstKey);
    if (members) members.push(commit);
    else bursts.set(burstKey, [commit]);
  }
  return [...bursts.values()].map(joinLogicalChanges);
}

/** One commit of a burst, before joining: its partitioned files and its message's task ids. */
interface ShotgunSurgeryCommit {
  bundleId: number;
  filesByComponent: Map<string, Set<RelPath>>;
  taskIds: readonly string[];
}

/** One burst's commits joined into logical changes — the connected components of the join. */
function joinLogicalChanges(commits: readonly ShotgunSurgeryCommit[]): ShotgunSurgeryChangeUnit[] {
  const parent = commits.map((_, index) => index);
  const find = (start: number): number => {
    let root = start;
    while (parent[root] !== root) root = parent[root];
    for (let node = start; parent[node] !== root; ) {
      const next = parent[node];
      parent[node] = root;
      node = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  };
  // A task id first seen in one commit joins every later commit naming it.
  const taskOwner = new Map<string, number>();
  commits.forEach(({ taskIds }, index) => {
    for (const taskId of taskIds) {
      const owner = taskOwner.get(taskId);
      if (owner === undefined) taskOwner.set(taskId, index);
      else union(owner, index);
    }
  });
  const units = new Map<number, ShotgunSurgeryChangeUnit>();
  commits.forEach(({ bundleId, filesByComponent }, index) => {
    const root = find(index);
    const unit = units.get(root);
    if (!unit) {
      units.set(root, {
        filesByComponent: new Map([...filesByComponent].map(([c, relPaths]) => [c, new Set(relPaths)])),
        bundleIds: [bundleId],
      });
      return;
    }
    unit.bundleIds.push(bundleId);
    for (const [component, relPaths] of filesByComponent) {
      const held = unit.filesByComponent.get(component);
      if (held) for (const relPath of relPaths) held.add(relPath);
      else unit.filesByComponent.set(component, new Set(relPaths));
    }
  });
  return [...units.values()];
}

/**
 * The change units in the pair gate's two counts. Identical component sets of
 * one burst are one counted unit (the gate's distinct pairs per burst). A
 * burst's union only feeds the degrees — n_c and the burst widths M is drawn
 * from — never a unit.
 */
function buildHistory(input: ShotgunSurgeryInput): ShotgunSurgeryHistory {
  const units: ShotgunSurgeryUnit[] = [];
  const changes = new Map<string, number>();
  const burstWidths = new Map<number, number>();
  const bursts = changeUnitsByBurst(input);
  bursts.forEach((changeUnits, burst) => {
    const distinct = new Map<string, ShotgunSurgeryUnit>();
    for (const { filesByComponent, bundleIds } of changeUnits) {
      const setKey = [...filesByComponent.keys()].sort(compareCodePoints).join("\u0000");
      const unit = distinct.get(setKey);
      if (!unit) {
        distinct.set(setKey, {
          burst,
          components: new Set(filesByComponent.keys()),
          filesByComponent: new Map([...filesByComponent].map(([c, relPaths]) => [c, new Set(relPaths)])),
          order: Math.max(...bundleIds),
          bundleIds: [...bundleIds],
        });
        continue;
      }
      unit.order = Math.max(unit.order, ...bundleIds);
      unit.bundleIds.push(...bundleIds);
      for (const [component, relPaths] of filesByComponent) {
        const held = unit.filesByComponent.get(component);
        for (const relPath of relPaths) held?.add(relPath);
      }
    }
    const union = new Set<string>();
    for (const unit of distinct.values()) {
      unit.bundleIds.sort((a, b) => b - a);
      units.push(unit);
      for (const c of unit.components) union.add(c);
    }
    for (const c of union) changes.set(c, (changes.get(c) ?? 0) + 1);
    burstWidths.set(union.size, (burstWidths.get(union.size) ?? 0) + 1);
  });
  return { units, burstCount: bursts.length, changes, burstWidths };
}

/**
 * A set of components with the (ascending) indices of the wide per-commit sets
 * holding all of it, and its support: the distinct bursts among them.
 */
interface ShotgunSurgeryUnitSet {
  components: string[];
  unitIndices: number[];
  support: number;
}

/**
 * Every set of exactly `k` components wide commits of at least
 * {@link TEMPORAL_COCHANGE_MIN_SUPPORT} bursts held whole, with those commits.
 * Depth-first over code-point-ordered components, intersecting the commits'
 * index lists as it extends a prefix and abandoning a prefix the moment fewer
 * than the minimum support of bursts still hold it — so the walk visits only
 * the subsets that recur, never the C(n, k) family itself. A set fewer bursts
 * held is untested and counts in the family with p = 1, as an unobserved pair
 * does in the pair gate.
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
    .filter(([, list]) => distinctBursts(wide, list) >= TEMPORAL_COCHANGE_MIN_SUPPORT)
    .sort(([a], [b]) => compareCodePoints(a, b));
  const sets: ShotgunSurgeryUnitSet[] = [];
  const prefix: string[] = [];
  const extend = (start: number, unitIndices: readonly number[] | undefined): void => {
    for (let i = start; i <= items.length - (k - prefix.length); i++) {
      const [component, list] = items[i];
      const shared = unitIndices === undefined ? list : intersectSorted(unitIndices, list);
      const support = distinctBursts(wide, shared);
      if (support < TEMPORAL_COCHANGE_MIN_SUPPORT) continue;
      prefix.push(component);
      if (prefix.length === k) sets.push({ components: [...prefix], unitIndices: [...shared], support });
      else extend(i + 1, shared);
      prefix.pop();
    }
  };
  if (k > 0) extend(0, undefined);
  return sets;
}

/** Distinct author bursts among the per-commit sets at `indices`. */
function distinctBursts(units: readonly ShotgunSurgeryUnit[], indices: readonly number[]): number {
  return new Set(indices.map((index) => units[index].burst)).size;
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
 * admitted k-set lying inside the components EVERY commit that held it
 * touched — the closure of its recurrences. Every holding commit, not one
 * picked per burst: the intersection needs no tie-break, so it is
 * deterministic by construction, and it is the conservative reading — a
 * component joins the spread only if no commit that made the k-set recur left
 * it out. The spread is thereby a commit-level fact: every supporting burst
 * holds a commit that edited the whole spread, so its support is exactly the
 * k-set's, and k-sets held by the same commits collapse into one spread. Two
 * k-sets held by different commits stay apart even when they share
 * components: their union is reported only if commits held the whole of it.
 * Restricting the closure to admitted k-sets keeps a component the null
 * explains — one in nearly every change — out of a spread it was never
 * significant in.
 */
function mergeIntoMaximalSpreads(
  admitted: readonly ShotgunSurgeryUnitSet[],
  wide: readonly ShotgunSurgeryUnit[],
): ShotgunSurgeryUnitSet[] {
  const byRecurrence = new Map<string, ShotgunSurgeryUnitSet>();
  for (const set of admitted) byRecurrence.set(set.unitIndices.join(","), set);
  const spreads: ShotgunSurgeryUnitSet[] = [];
  for (const { unitIndices, support } of byRecurrence.values()) {
    const units = unitIndices.map((index) => wide[index].components);
    const members = new Set<string>();
    for (const { components } of admitted) {
      if (components.every((c) => units.every((unit) => unit.has(c)))) for (const c of components) members.add(c);
    }
    spreads.push({ components: [...members].sort(compareCodePoints), unitIndices, support });
  }
  return spreads.sort((a, b) => compareKeys(a.components, b.components));
}

/**
 * C(n, k): every set of exactly k components among the n changed in ≥ 2
 * bursts — the a-priori family, the pair gate's C(|F₂|, 2) lifted to k. Clamped
 * to the largest finite double.
 */
export function shotgunSurgeryFamilySize(n: number, k: number): number {
  if (k < 0 || n < k) return 0;
  let binomial = 1;
  for (let i = 0; i < k; i++) binomial = (binomial * (n - i)) / (i + 1);
  return Math.min(Math.round(binomial), Number.MAX_VALUE);
}

/**
 * The fitted-propensity null: x_c with Σ_w bursts_w·(1 − (1 − x_c)^w) = n_c
 * over the bursts' widths (the pair gate's degrees n_f and M), solved by
 * bisection on [0, 1] — the left side rises monotonically from 0 to the burst
 * count, which n_c never exceeds. Expected support sums over the per-commit
 * sets' widths (the gate's Qs).
 */
class PropensityModel {
  private readonly propensity = new Map<string, number>();

  constructor(
    private readonly changes: ReadonlyMap<string, number>,
    private readonly burstWidths: ReadonlyMap<number, number>,
    private readonly unitWidths: ReadonlyMap<number, number>,
  ) {}

  /** λ_S = Σ_w units_w · Π_{c∈S} (1 − (1 − x_c)^w). */
  expectedSupport(components: readonly string[]): number {
    const xs = components.map((c) => this.propensityOf(c));
    let total = 0;
    for (const [width, count] of this.unitWidths) {
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
      for (const [width, count] of this.burstWidths) expected += count * inclusion(mid, width);
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
  const carrierFiles = spread.components.map((c) => carrierFilesOf(spread.supporting, c));
  const fewest = Math.min(...componentChanges);
  const most = Math.max(...componentChanges);
  // One commit per supporting burst — its most recent commit that held the
  // spread — so every sample is a distinct supporting change, never a burst's
  // re-commits crowding the others out.
  const latestPerBurst = new Map<number, ShotgunSurgeryUnit>();
  for (const unit of spread.supporting) {
    const latest = latestPerBurst.get(unit.burst);
    if (!latest || unit.order > latest.order) latestPerBurst.set(unit.burst, unit);
  }
  const sampleCommits: string[] = [];
  const sampleChanges: string[][] = [];
  for (const unit of [...latestPerBurst.values()].sort((a, b) => b.order - a.order)) {
    if (sampleChanges.length >= SHOTGUN_SURGERY_SAMPLE_COMMITS) break;
    for (const sha of bundleCommits?.get(unit.order) ?? []) {
      if (!sampleCommits.includes(sha)) sampleCommits.push(sha);
    }
    const change = unit.bundleIds.flatMap((bundleId) => bundleCommits?.get(bundleId) ?? []);
    if (change.length > 0) sampleChanges.push([...new Set(change)]);
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
    exemplarFiles: carrierFiles.map((files) => files[0] ?? ""),
    carrierFiles,
    sampleCommits,
    sampleChanges,
  };
}

/**
 * The component's files the supporting changes touched, most-touched first,
 * ties to the smaller path, at most {@link SHOTGUN_SURGERY_CARRIER_FILES}.
 */
function carrierFilesOf(units: readonly ShotgunSurgeryUnit[], component: string): RelPath[] {
  const counts = new Map<RelPath, number>();
  for (const unit of units) {
    for (const relPath of unit.filesByComponent.get(component) ?? []) {
      counts.set(relPath, (counts.get(relPath) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([pa, ca], [pb, cb]) => cb - ca || compareCodePoints(pa, pb))
    .slice(0, SHOTGUN_SURGERY_CARRIER_FILES)
    .map(([relPath]) => relPath);
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
