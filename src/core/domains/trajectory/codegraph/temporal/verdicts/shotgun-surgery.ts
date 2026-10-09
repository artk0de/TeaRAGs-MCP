/**
 * Shotgun surgery over the temporal co-change bundles (bd
 * tea-rags-mcp-r8hme.50): ONE change spread over N components, recurring more
 * often than chance, with nothing in the structural graph explaining why the
 * change has to touch all of them. Silent coupling's N-way sibling — silent
 * coupling judges file pairs, MERGE judges component pairs that almost always
 * move together; this judges the fan-out of a single change.
 *
 * THE UNIT is the pair significance gate's, lifted to sets
 * (`assessBurstCochangeSignificance`, bd tea-rags-mcp-3vg0x) and widened to
 * the logical change (bd tea-rags-mcp-bvcg4): a k-set is supported by a
 * DISTINCT LOGICAL CHANGE only when one change held all k components. A
 * logical change is the history's commits joined by a shared task id — across
 * bursts, umbrella ids excepted ({@link joinLogicalChanges},
 * {@link resolveUmbrellaTaskIds}); with nothing joining them it is one commit.
 * Changes sharing an author burst count as one ({@link changeGroups}): the
 * burst still stops a WIP spray of re-commits from counting as many changes.
 * A burst's union is never a unit — parallel agent sessions committing under
 * one author chain unrelated commits into it, so a union spread is one no
 * single change ever touched. The units are the changes' component sets,
 * identical sets sharing a burst deduplicated (the gate's
 * distinct-pairs-per-burst). A bundle without a recorded burst is its own.
 * Only partitioned (production) files count; nothing is filtered by file type
 * or by how often a component changes.
 *
 * WIDE. A unit is wide when it spans ≥ k components. k is the codebase's own:
 * the majority-floored Otsu split over every unit's width
 * ({@link resolveMajorityFlooredOtsuThreshold}), never below
 * {@link SHOTGUN_SURGERY_MIN_WIDTH} — two components are the pair question
 * MERGE and silent coupling already answer.
 *
 * RECURRING. The tested sets are k-sets: sets of EXACTLY k components that
 * wide units of ≥ 2 distinct changes (the build's minimum support) each held
 * whole. A set's support is those changes; its WEIGHTED support sums each
 * change's specificity ({@link ShotgunSurgerySpecificity}) — whole up to the
 * codebase's typical change width T, C(T, k) / C(w, k) beyond it, so a sweep
 * across w components says almost nothing about any one triple inside it.
 *
 * THE NULL is the pair gate's configuration null lifted to sets, built from
 * the same counts. The gate takes degrees from bursts — n_f = bursts touching
 * f, M = Σ the bursts' file counts — and opportunities from commits — Qs =
 * the distinct pairs ONE commit held per burst. Here likewise: x_c is fitted so
 * Σ_b P(c ∈ b) over the bursts' widths equals n_c, the bursts touching c
 * (P(c ∈ u) = 1 − (1 − x_c)^w for a set of width w), and the opportunities are
 * the units. The test statistic and its null are the SAME weighted count:
 * under independence each width-w unit holds S with π_w = Π_{c∈S} P(c ∈ u),
 * so W_units = Σ_w weight_w · N_w with N_w ~ Binomial(units_w, π_w) — a
 * compound Poisson (weight_w, μ_w = units_w·π_w) bounds its moment generating
 * function. The observed statistic counts each distinct change once at its
 * most specific unit, so it never exceeds W_units: P(W_units ≥ w_obs) is a
 * valid p. Its tail is bounded, never approximated
 * ({@link compoundPoissonUpperTailBound}): the chance of one event at least
 * w_obs heavy, plus Chernoff over the lighter ones — so p is super-uniform and
 * BH keeps its FDR guarantee. A component in most changes has P near 1 in
 * every wide set, so its spreads' expectation absorbs their support: the
 * conditioning IS the hub correction, exactly as in the pair gate.
 * Multiplicity = Benjamini–Hochberg at the pair gate's q over the a-priori
 * family C(n, k) — every set of exactly k components among the n changed in
 * ≥ 2 bursts, the pair gate's C(|F₂|, 2) lifted to k
 * ({@link shotgunSurgeryFamilySize}). An untested member counts with p = 1. A
 * family over every width k..widest (≈ 2e21 on tea-rags's own history) would
 * demand p < 1e-23 and admit nothing.
 *
 * MAXIMAL SPREADS. Admitted k-sets merge into the spreads reported: a k-set's
 * spread is every admitted k-set inside the components EVERY unit that held
 * it touched ({@link mergeIntoMaximalSpreads}), so a wider fan-out shows as one
 * spread with the k-set's support, never as C(width, k) findings — and every
 * supporting change holds a unit that edited the whole spread.
 *
 * EXPLAINED. A spread is explained when its components form ONE structurally
 * connected group: two components are joined by a component dependency
 * (either direction) or by a specific shared neighbour — silent coupling's
 * {@link SilentCouplingNeighbourIndex} over the component graph, its
 * ln(N / fanIn) weight clearing an Otsu cut drawn over every unlinked pair's
 * heaviest neighbour (Otsu only: under the floor alone every non-universal
 * neighbour would explain) — or by one FEATURE SUBTREE
 * ({@link ShotgunSurgeryFeatureSubtrees}): siblings under a directory or
 * namespace small enough for one typical change to edit whole. A spread whose
 * components fall into ≥ 2 islands is the violation: the change keeps
 * reaching into parts the code never connects.
 *
 * STRENGTH is {@link cochangeStrength} over the spread's support and its
 * least- and most-changed components — the larger direction's Wilson lower
 * bound, the severity. Pure: ports in, verdicts out; no bundle membership →
 * nothing judged, never zeros posing as verdicts.
 */

import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../infra/graph/index.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import { componentAncestry } from "../../symbols/boundary-diagnostics/index.js";
import {
  benjaminiHochbergRejectionCount,
  COCHANGE_SIGNIFICANCE_FDR_Q,
  cochangeStrength,
  SILENT_COUPLING_OTSU_MIN_POPULATION,
  SILENT_COUPLING_SHARED_NEIGHBOUR_WEIGHT_FLOOR,
  SilentCouplingNeighbourIndex,
} from "../boundary-diagnostics/index.js";
import { TEMPORAL_COCHANGE_MIN_SUPPORT, tukeyCutOverLog2 } from "../cochange/index.js";

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
  /** Distinct logical changes that held the whole spread (changes sharing an author burst count once). */
  support: number;
  /**
   * Σ over those changes of their specificity weight at the spread's width m
   * ({@link ShotgunSurgerySpecificity}), each taken at its narrowest holding
   * unit: 1 up to the typical width T, C(T, m) / C(w, m) beyond it.
   */
  weightedSupport: number;
  /** E[weightedSupport] under component independence: Σ_w units_w · P(spread ⊆ u | w) · weight_w over widths w ≥ m. */
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
  /** Logical changes' component sets (identical sets sharing a burst once) — the width model's population. */
  unitCount: number;
  /**
   * The umbrella cut: a task id whose commits carry more distinct task ids
   * than this joins nothing (Tukey's fence over log2 of that breadth). Absent
   * when no task id names a companion.
   */
  umbrellaTaskIdCut?: number;
  /** Task ids above {@link umbrellaTaskIdCut} — epic / umbrella ids left out of the join. */
  umbrellaTaskIdCount: number;
  /** T — the Tukey fence over the units' widths: a change up to T components weighs 1, a wider one C(T, m) / C(w, m). */
  typicalChangeWidth?: number;
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

/** One counted unit: a logical change's component set (identical sets sharing a burst once). */
interface ShotgunSurgeryUnit {
  /** Indices of the author bursts the unit's commits fall in, ascending. */
  bursts: number[];
  components: Set<string>;
  filesByComponent: Map<string, Set<RelPath>>;
  /** Largest bundle id — the recency order. */
  order: number;
  /** The bundles (one commit each) of the change units with this component set, descending. */
  bundleIds: number[];
}

/** The history in the pair gate's two counts: logical-change sets, and the bursts they fall in. */
interface ShotgunSurgeryHistory {
  /** Logical-change component sets, identical sets sharing a burst once. */
  units: ShotgunSurgeryUnit[];
  burstCount: number;
  /** n_c — bursts with a commit touching c. */
  changes: Map<string, number>;
  /** Width → bursts touching that many components — the degrees' M. */
  burstWidths: Map<number, number>;
  umbrella: ShotgunSurgeryUmbrellaTaskIds;
}

interface AdmittedSpread {
  components: string[];
  support: number;
  weightedSupport: number;
  expectedSupport: number;
  /** The commits (per-commit sets) that held the spread. */
  supporting: ShotgunSurgeryUnit[];
}

/** Judge the history's wide changes. See the module docblock for every contract. */
export function detectShotgunSurgery(input: ShotgunSurgeryInput): ShotgunSurgeryReport {
  const { units, burstCount, changes, burstWidths, umbrella } = buildHistory(input);
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

  const specificity = new ShotgunSurgerySpecificity(widths);
  const propensity = new PropensityModel(changes, burstWidths, unitWidths, specificity);
  const tested = recurringKSets(wide, widthThreshold).map((set) => ({
    ...set,
    p: compoundPoissonUpperTailBound(
      weightedSupportOf(wide, set.unitIndices, widthThreshold, specificity),
      propensity.weightedNull(set.components),
    ),
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
      weightedSupport: weightedSupportOf(wide, unitIndices, components.length, specificity),
      expectedSupport: expectedWeightedSupport(propensity.weightedNull(components)),
      supporting: unitIndices.map((index) => wide[index]),
    }),
  );

  const structure = new ShotgunSurgeryStructure(
    input.componentDependencies,
    input.componentOf,
    new ShotgunSurgeryFeatureSubtrees(changes.keys(), specificity.typicalWidth),
  );
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
      ...(umbrella.cut === undefined ? {} : { umbrellaTaskIdCut: umbrella.cut }),
      umbrellaTaskIdCount: umbrella.ids.size,
      ...(specificity.typicalWidth === undefined ? {} : { typicalChangeWidth: specificity.typicalWidth }),
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

/** One logical change: the partitioned files it edited, the bundles (commits) that made it, and their bursts. */
interface ShotgunSurgeryChangeUnit {
  filesByComponent: Map<string, Set<RelPath>>;
  bundleIds: number[];
  bursts: Set<number>;
}

/** One commit before joining: its burst, its partitioned files and its message's task ids. */
interface ShotgunSurgeryCommit {
  bundleId: number;
  burst: number;
  filesByComponent: Map<string, Set<RelPath>>;
  taskIds: readonly string[];
}

/** The umbrella task ids, and the cut over the ids' breadth that named them. */
interface ShotgunSurgeryUmbrellaTaskIds {
  /** Absent when no task id names a companion — no breadth sample, nothing judged. */
  cut: number | undefined;
  ids: ReadonlySet<string>;
}

/**
 * The commits touching a partitioned file, each with the index of its author
 * burst (first-seen order); a bundle without a recorded burst is its own.
 */
function collectCommits(input: ShotgunSurgeryInput): { commits: ShotgunSurgeryCommit[]; burstCount: number } {
  const burstIndex = new Map<string, number>();
  const commits: ShotgunSurgeryCommit[] = [];
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
    const recorded = input.bundleBursts?.get(bundleId);
    const burstKey = recorded === undefined ? `bundle:${bundleId}` : `burst:${recorded}`;
    let burst = burstIndex.get(burstKey);
    if (burst === undefined) {
      burst = burstIndex.size;
      burstIndex.set(burstKey, burst);
    }
    commits.push({ bundleId, burst, filesByComponent, taskIds: input.bundleTaskIds?.get(bundleId) ?? [] });
  }
  return { commits, burstCount: burstIndex.size };
}

/**
 * UMBRELLA TASK IDS. A task id is specific when it names ONE change; an
 * epic or umbrella id rides on the commits of many sub-tasks, and joining
 * through it chains them into one blob no single change made (TD-82211 in
 * taxdome chained nine sub-tasks of a hook migration into a 93-file unit).
 *
 * The measure is an id's BREADTH: the distinct task ids its commits carry,
 * itself included. Breadth, not commit count: a long task re-committed a
 * hundred times is still one change, and joining it is the whole point of the
 * cross-burst join — a commit-count cut would flag exactly the long tasks the
 * join exists for. What makes an id an umbrella is that it names many OTHER
 * changes. An id whose commits carry no other id has breadth 1 and bridges
 * nothing, so (like single-file bundles at the file level) it stays out of
 * the sample.
 *
 * The cut is the temporal family's one Tukey fence, {@link tukeyCutOverLog2}
 * over log2 of the breadths ≥ 2, inclusive. Otsu was the other candidate and
 * fails the separability gate on taxdome (0.73 on log breadth), so it would
 * fall back to a majority floor — a constant. An id above the cut joins
 * nothing: its commits join only through their other ids, or stand alone.
 */
function resolveUmbrellaTaskIds(commits: readonly ShotgunSurgeryCommit[]): ShotgunSurgeryUmbrellaTaskIds {
  const breadth = new Map<string, Set<string>>();
  for (const { taskIds } of commits) {
    for (const taskId of taskIds) {
      const carried = breadth.get(taskId);
      if (carried) for (const other of taskIds) carried.add(other);
      else breadth.set(taskId, new Set(taskIds));
    }
  }
  const bridging = [...breadth.values()].map((ids) => ids.size).filter((size) => size >= 2);
  if (bridging.length === 0) return { cut: undefined, ids: new Set() };
  const cut = tukeyCutOverLog2(bridging, { min: 2, max: Math.max(...bridging) });
  const ids = new Set([...breadth].filter(([, carried]) => carried.size > cut).map(([taskId]) => taskId));
  return { cut, ids };
}

/**
 * THE CHANGE-UNIT SEAM — the one place that decides what "one change" is;
 * support, the null's opportunities, the width model, the closure and the
 * sample commits all consume its units and their bundle ids, never a bundle
 * directly.
 *
 * A change unit is a LOGICAL change (bd tea-rags-mcp-09c4m, bd
 * tea-rags-mcp-bvcg4): the connected components of the history's commits
 * under "one change", where two commits are one change when their messages
 * name a common task id that is not an umbrella
 * ({@link resolveUmbrellaTaskIds}). The join crosses bursts — one task
 * committed on Monday and again on Wednesday is one change, not two — and
 * spans the whole co-change window the build read. A unit is the union of
 * its commits' files and carries all their bundle ids and bursts. Structure
 * never joins: a shared file or a dependency edge is no evidence of one
 * change - measured on tea-rags, joining through them chained whole bursts
 * (provider.ts sits in 144 commits) into 8-152-commit "changes" and turned 0
 * shotgun violations into 5. Semantics (similar code across components) never
 * joins either: it only explains a reported spread, and the consuming agent
 * judges that. Without a joining task id a unit is one commit.
 *
 * ECHOES — a revert, or a feature flag added and later removed — are the same
 * logical event twice. A revert that keeps its original's message keeps its
 * task id and joins here. Anything else needs the inverse-diff evidence (per
 * file added / deleted lines mirrored), which the co-change store does not
 * persist: `cg_temporal_bundle_files` holds paths only. Until it does, an echo
 * without a shared task id counts as a second change.
 */
function joinLogicalChanges(
  commits: readonly ShotgunSurgeryCommit[],
  umbrella: ShotgunSurgeryUmbrellaTaskIds,
): ShotgunSurgeryChangeUnit[] {
  const joins = new DisjointSets(commits.length);
  // A task id first seen in one commit joins every later commit naming it.
  const taskOwner = new Map<string, number>();
  commits.forEach(({ taskIds }, index) => {
    for (const taskId of taskIds) {
      if (umbrella.ids.has(taskId)) continue;
      const owner = taskOwner.get(taskId);
      if (owner === undefined) taskOwner.set(taskId, index);
      else joins.union(owner, index);
    }
  });
  const units = new Map<number, ShotgunSurgeryChangeUnit>();
  commits.forEach(({ bundleId, burst, filesByComponent }, index) => {
    const root = joins.find(index);
    const unit = units.get(root);
    if (!unit) {
      units.set(root, {
        filesByComponent: new Map([...filesByComponent].map(([c, relPaths]) => [c, new Set(relPaths)])),
        bundleIds: [bundleId],
        bursts: new Set([burst]),
      });
      return;
    }
    unit.bundleIds.push(bundleId);
    unit.bursts.add(burst);
    mergeFiles(unit.filesByComponent, filesByComponent);
  });
  return [...units.values()];
}

/**
 * The change units in the pair gate's two counts. Identical component sets
 * sharing a burst are one counted unit (the gate's distinct pairs per burst) —
 * a WIP spray re-committing the same spread, with no task id to join it, is
 * one change. A burst's union only feeds the degrees — n_c and the burst
 * widths M is drawn from — never a unit.
 */
function buildHistory(input: ShotgunSurgeryInput): ShotgunSurgeryHistory {
  const { commits, burstCount } = collectCommits(input);
  const burstComponents = Array.from({ length: burstCount }, () => new Set<string>());
  for (const { burst, filesByComponent } of commits) {
    for (const c of filesByComponent.keys()) burstComponents[burst].add(c);
  }
  const changes = new Map<string, number>();
  const burstWidths = new Map<number, number>();
  for (const union of burstComponents) {
    for (const c of union) changes.set(c, (changes.get(c) ?? 0) + 1);
    burstWidths.set(union.size, (burstWidths.get(union.size) ?? 0) + 1);
  }

  const umbrella = resolveUmbrellaTaskIds(commits);
  const changeUnits = joinLogicalChanges(commits, umbrella);
  const sameSet = new DisjointSets(changeUnits.length);
  const firstBySetAndBurst = new Map<string, number>();
  const setKeys = changeUnits.map(({ filesByComponent }) =>
    [...filesByComponent.keys()].sort(compareCodePoints).join("\u0000"),
  );
  changeUnits.forEach(({ bursts }, index) => {
    for (const burst of bursts) {
      const key = `${setKeys[index]}\u0001${burst}`;
      const first = firstBySetAndBurst.get(key);
      if (first === undefined) firstBySetAndBurst.set(key, index);
      else sameSet.union(first, index);
    }
  });
  const merged = new Map<number, ShotgunSurgeryUnit>();
  changeUnits.forEach(({ filesByComponent, bundleIds, bursts }, index) => {
    const root = sameSet.find(index);
    const unit = merged.get(root);
    if (!unit) {
      merged.set(root, {
        bursts: [...bursts],
        components: new Set(filesByComponent.keys()),
        filesByComponent: new Map([...filesByComponent].map(([c, relPaths]) => [c, new Set(relPaths)])),
        order: Math.max(...bundleIds),
        bundleIds: [...bundleIds],
      });
      return;
    }
    unit.order = Math.max(unit.order, ...bundleIds);
    unit.bundleIds.push(...bundleIds);
    unit.bursts.push(...bursts);
    mergeFiles(unit.filesByComponent, filesByComponent);
  });
  const units = [...merged.values()];
  for (const unit of units) {
    unit.bundleIds.sort((a, b) => b - a);
    unit.bursts = [...new Set(unit.bursts)].sort((a, b) => a - b);
  }
  return { units, burstCount, changes, burstWidths, umbrella };
}

/** Add `from`'s files into `into`, component by component. */
function mergeFiles(into: Map<string, Set<RelPath>>, from: ReadonlyMap<string, ReadonlySet<RelPath>>): void {
  for (const [component, relPaths] of from) {
    const held = into.get(component);
    if (held) for (const relPath of relPaths) held.add(relPath);
    else into.set(component, new Set(relPaths));
  }
}

/** Union-find over 0..n−1 with path compression; the smaller index is the root. */
class DisjointSets {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(start: number): number {
    let root = start;
    while (this.parent[root] !== root) root = this.parent[root];
    for (let node = start; this.parent[node] !== root; ) {
      const next = this.parent[node];
      this.parent[node] = root;
      node = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
  }
}

/**
 * A set of components with the (ascending) indices of the wide units holding
 * all of it, and its support: the distinct logical changes among them
 * ({@link changeGroups}).
 */
interface ShotgunSurgeryUnitSet {
  components: string[];
  unitIndices: number[];
  support: number;
}

/**
 * Every set of exactly `k` components wide units of at least
 * {@link TEMPORAL_COCHANGE_MIN_SUPPORT} distinct changes held whole, with
 * those units. Depth-first over code-point-ordered components, intersecting
 * the units' index lists as it extends a prefix and abandoning a prefix the
 * moment fewer than the minimum support of changes still hold it — so the
 * walk visits only the subsets that recur, never the C(n, k) family itself. A
 * set fewer changes held is untested and counts in the family with p = 1, as
 * an unobserved pair does in the pair gate.
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
    .filter(([, list]) => distinctChanges(wide, list) >= TEMPORAL_COCHANGE_MIN_SUPPORT)
    .sort(([a], [b]) => compareCodePoints(a, b));
  const sets: ShotgunSurgeryUnitSet[] = [];
  const prefix: string[] = [];
  const extend = (start: number, unitIndices: readonly number[] | undefined): void => {
    for (let i = start; i <= items.length - (k - prefix.length); i++) {
      const [component, list] = items[i];
      const shared = unitIndices === undefined ? list : intersectSorted(unitIndices, list);
      const support = distinctChanges(wide, shared);
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

/**
 * The units at `indices` grouped into distinct changes: units sharing an
 * author burst are one change (a WIP spray, or parallel commits a task id did
 * not join, is one event of that burst), transitively. Units at distinct
 * indices never share a non-umbrella task id — the join already merged those.
 */
function changeGroups(units: readonly ShotgunSurgeryUnit[], indices: readonly number[]): number[][] {
  const joins = new DisjointSets(indices.length);
  const burstOwner = new Map<number, number>();
  indices.forEach((index, position) => {
    for (const burst of units[index].bursts) {
      const owner = burstOwner.get(burst);
      if (owner === undefined) burstOwner.set(burst, position);
      else joins.union(owner, position);
    }
  });
  const groups = new Map<number, number[]>();
  indices.forEach((index, position) => {
    const root = joins.find(position);
    const group = groups.get(root);
    if (group) group.push(index);
    else groups.set(root, [index]);
  });
  return [...groups.values()];
}

/** Distinct changes among the units at `indices` — the support. */
function distinctChanges(units: readonly ShotgunSurgeryUnit[], indices: readonly number[]): number {
  // One burst per unit is the common case: the changes are the distinct bursts.
  if (indices.every((index) => units[index].bursts.length === 1)) {
    return new Set(indices.map((index) => units[index].bursts[0])).size;
  }
  return changeGroups(units, indices).length;
}

/**
 * The weighted support of a width-`m` set held by the units at `indices`:
 * Σ over its distinct changes of the change's specificity weight
 * ({@link ShotgunSurgerySpecificity}), taken at the change's narrowest
 * holding unit.
 */
function weightedSupportOf(
  units: readonly ShotgunSurgeryUnit[],
  indices: readonly number[],
  m: number,
  specificity: ShotgunSurgerySpecificity,
): number {
  let total = 0;
  for (const group of changeGroups(units, indices)) {
    total += Math.max(...group.map((index) => specificity.weight(units[index].components.size, m)));
  }
  return total;
}

/**
 * SPECIFICITY. A change touching w components is evidence about any ONE
 * m-set inside it in proportion to how few m-sets it could have meant:
 * C(T, m) / C(w, m) for a change wider than the codebase's typical change T,
 * 1 within it. T is the temporal family's one Tukey fence
 * ({@link tukeyCutOverLog2}) over log2 of the units' widths — the width
 * beyond which a change is an outlier of this history (a sweep, a migration,
 * a flag removal), never below m.
 *
 * Why the fence and not the bare 1 / C(w, m): the bare share makes ONE
 * change of exactly m components outweigh any number of ordinary changes —
 * two genuine 8-component changes weigh 2/56 — so the tail floors at the
 * chance of a single specific coincidence, ~λ, and no set at the C(n, k)
 * family's BH threshold (~1e-10 on taxdome) ever clears it. Measured on the
 * taxdome gold set: the bare share admitted 23 of 44 910 candidate triples and
 * recalled 0 of 7 true findings. Inside the fence a change counts whole, as
 * the unweighted test counted it; beyond it the weight falls as 1 / C(w, m),
 * so a 86-component sweep gives one triple C(T, 3) / C(86, 3) — about 0.5% on
 * taxdome. Chosen over an IDF weight (−log of the share of units that wide):
 * that one rises with rarity and would reward the sweeps.
 */
class ShotgunSurgerySpecificity {
  /** T — the Tukey fence over the units' widths; undefined when no unit pairs two components. */
  readonly typicalWidth: number | undefined;

  constructor(widths: readonly number[]) {
    const pairing = widths.filter((width) => width >= 2);
    this.typicalWidth =
      pairing.length === 0 ? undefined : tukeyCutOverLog2(pairing, { min: 2, max: Math.max(...pairing) });
  }

  /** The weight of a width-`width` change as evidence for one m-set inside it; 0 below m. */
  weight(width: number, m: number): number {
    if (width < m) return 0;
    const reference = Math.max(m, this.typicalWidth ?? m);
    if (width <= reference) return 1;
    return binomialCoefficient(reference, m) / binomialCoefficient(width, m);
  }
}

/** C(n, m) as a double, unrounded. */
function binomialCoefficient(n: number, m: number): number {
  let binomial = 1;
  for (let i = 0; i < m; i++) binomial = (binomial * (n - i)) / (i + 1);
  return binomial;
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
 * count, which n_c never exceeds. The opportunities are the logical-change
 * units' widths (the gate's Qs).
 */
class PropensityModel {
  private readonly propensity = new Map<string, number>();

  constructor(
    private readonly changes: ReadonlyMap<string, number>,
    private readonly burstWidths: ReadonlyMap<number, number>,
    private readonly unitWidths: ReadonlyMap<number, number>,
    private readonly specificity: ShotgunSurgerySpecificity,
  ) {}

  /**
   * The weighted support's null, one compound-Poisson term per unit width
   * w ≥ m (m = |S|; a narrower unit cannot hold S): the width's specificity
   * weight — the same weight the observed changes carry — and mean
   * μ_w = units_w · Π_{c∈S} (1 − (1 − x_c)^w) — the expected number of
   * width-w units holding S.
   */
  weightedNull(components: readonly string[]): CompoundPoissonTerm[] {
    const xs = components.map((c) => this.propensityOf(c));
    const terms: CompoundPoissonTerm[] = [];
    for (const [width, count] of this.unitWidths) {
      if (width < components.length) continue;
      let mean = count;
      for (const x of xs) mean *= inclusion(x, width);
      terms.push({ weight: this.specificity.weight(width, components.length), mean });
    }
    return terms;
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

/** One class of a compound-Poisson sum: events of `weight`, `mean` of them expected. */
export interface CompoundPoissonTerm {
  weight: number;
  mean: number;
}

/** Expected value of the compound sum: Σ weight · mean. */
function expectedWeightedSupport(terms: readonly CompoundPoissonTerm[]): number {
  return terms.reduce((total, { weight, mean }) => total + weight * mean, 0);
}

/** Bisection steps for the Chernoff tilt — any tilt gives a valid bound, so this only tightens it. */
const CHERNOFF_TILT_BISECTION_STEPS = 200;

/**
 * An upper bound on P(W ≥ observed) for W = Σ_i weight_i · N_i, N_i
 * independent Poisson(mean_i) — or independent Binomials of those means,
 * whose moment generating function the Poisson one dominates.
 *
 * Split at `observed`: W reaches it either through one event at least that
 * heavy (probability ≤ Σ of those means, the union bound) or through the
 * lighter events alone, bounded by Chernoff: P(W' ≥ x) ≤ exp(−(t·x − K(t)))
 * with K(t) = Σ mean·(e^{t·weight} − 1), at the tilt t where K'(t) = x. The
 * split matters: Chernoff alone prices "one heavy event" as e^{−~x·ln(x/μ)},
 * near 1 for a tiny x, while the event's probability is μ. With every weight
 * 1 and a rare event the bound is ≈ √(2πx) times the exact Poisson tail
 * (3.7× at x = 2, 6.2× at x = 6). A bound, never
 * an approximation, so a p-value from it is super-uniform under the null and
 * Benjamini–Hochberg keeps its FDR guarantee.
 */
export function compoundPoissonUpperTailBound(observed: number, terms: readonly CompoundPoissonTerm[]): number {
  const live = terms.filter(({ weight, mean }) => weight > 0 && mean > 0);
  if (observed <= expectedWeightedSupport(live)) return 1;
  let heavyMean = 0;
  const light: CompoundPoissonTerm[] = [];
  for (const term of live) {
    if (term.weight >= observed) heavyMean += term.mean;
    else light.push(term);
  }
  return Math.min(1, heavyMean + chernoffUpperTail(observed, light));
}

/** Chernoff's bound on P(Σ weight·N ≥ observed); 0 when no term can contribute. */
function chernoffUpperTail(observed: number, terms: readonly CompoundPoissonTerm[]): number {
  if (terms.length === 0) return 0;
  if (observed <= expectedWeightedSupport(terms)) return 1;
  // K'(t) = Σ mean·weight·e^{t·weight}, compared in log space: it overflows long before the tilt is found.
  const logTarget = Math.log(observed);
  const logSlope = (t: number): number =>
    logSumExp(terms.map(({ weight, mean }) => Math.log(mean) + Math.log(weight) + t * weight));
  let low = 0;
  let high = 1;
  while (logSlope(high) < logTarget) {
    low = high;
    high *= 2;
  }
  for (let step = 0; step < CHERNOFF_TILT_BISECTION_STEPS && high - low > Number.EPSILON * high; step++) {
    const mid = (low + high) / 2;
    if (logSlope(mid) < logTarget) low = mid;
    else high = mid;
  }
  const tilt = low;
  const cumulant = terms.reduce((total, { weight, mean }) => total + mean * Math.expm1(tilt * weight), 0);
  return Math.min(1, Math.exp(-(tilt * observed - cumulant)));
}

function logSumExp(values: readonly number[]): number {
  const peak = Math.max(...values);
  if (!Number.isFinite(peak)) return peak;
  return peak + Math.log(values.reduce((total, value) => total + Math.exp(value - peak), 0));
}

/**
 * FEATURE SUBTREES (bd tea-rags-mcp-bvcg4). Components are nodes of a tree —
 * a directory nests by path, a constant namespace by constant path
 * ({@link componentAncestry}) — and the independence null knows nothing of
 * it: siblings under one page or feature directory move together by
 * construction (a page and its elements, a board and its columns), so their
 * co-change clears the null without being shotgun surgery.
 *
 * A subtree is ONE FEATURE when one typical change can edit all of it: it
 * holds at most T changed components, T the typical change width
 * ({@link ShotgunSurgerySpecificity}). A component's feature is its outermost
 * ancestor that small; two components with the same feature join one island,
 * which is the same as their lowest common ancestor holding ≤ T changed
 * components (counts only grow outward). A component whose own subtree is
 * wider than T, or a pair in different trees — a namespace and a directory,
 * the backend and frontend halves of one feature — joins nothing here.
 *
 * Why T and not a cut over the spreads' own pairs: the owner's candidate was
 * an Otsu or Tukey cut over the LCA measure of every spread pair. Measured on
 * taxdome (1508 spreads, 5038 pairs): Otsu fails the 0.8 separability gate on
 * both the LCA depth (0.63) and log subtree size (0.75), and Tukey's fence
 * flags the wide tail, not the narrow one. T is itself the temporal family's
 * Tukey fence, drawn over the history's change widths — the scale at which
 * "one change" is still ordinary here (taxdome 31, tea-rags 11).
 *
 * Why an explanation and not a hierarchy-conditioned null (the other
 * candidate): refitting each set's propensities inside its LCA's subtree
 * admitted 913 of the 8965 k-sets the global null admits on taxdome, emptied
 * nearly every within-tree spread (1224 → 49), recalled 3 of the 7 true gold
 * findings even as sub-spreads, and left a report dominated by backend +
 * frontend slices. The explanation removed every sibling-subtree gold finding
 * and kept 6 of the 7 true ones.
 */
class ShotgunSurgeryFeatureSubtrees {
  private readonly featureOf = new Map<string, string | undefined>();
  private readonly changedUnder = new Map<string, number>();

  constructor(
    changedComponents: Iterable<string>,
    private readonly typicalWidth: number | undefined,
  ) {
    for (const component of changedComponents) {
      for (const node of componentAncestry(component)) {
        this.changedUnder.set(node, (this.changedUnder.get(node) ?? 0) + 1);
      }
    }
  }

  /** Whether `a` and `b` lie in one subtree a typical change covers whole. */
  joins(a: string, b: string): boolean {
    const feature = this.feature(a);
    return feature !== undefined && feature === this.feature(b);
  }

  /** The outermost ancestor holding ≤ T changed components; undefined when none does. */
  private feature(component: string): string | undefined {
    if (this.featureOf.has(component)) return this.featureOf.get(component);
    const width = this.typicalWidth;
    const feature =
      width === undefined
        ? undefined
        : componentAncestry(component).find((node) => (this.changedUnder.get(node) ?? 0) <= width);
    this.featureOf.set(component, feature);
    return feature;
  }
}

/**
 * The links among components that explain a spread: direct dependencies,
 * specific shared neighbours, and one feature subtree.
 */
class ShotgunSurgeryStructure {
  private readonly linked = new Set<string>();
  private readonly neighbours: SilentCouplingNeighbourIndex;

  constructor(
    dependencies: readonly ShotgunSurgeryComponentDependency[],
    componentOf: ReadonlyMap<RelPath, string>,
    private readonly featureSubtrees: ShotgunSurgeryFeatureSubtrees,
  ) {
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
      if (this.linked.has(key) || this.featureSubtrees.joins(a, b)) return true;
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
  // One unit per supporting change — its most recent unit that held the
  // spread — so every sample is a distinct supporting change, never a burst's
  // re-commits crowding the others out.
  const supporting = spread.supporting.map((_, index) => index);
  const latestPerChange = changeGroups(spread.supporting, supporting).map((group) =>
    group
      .map((index) => spread.supporting[index])
      .reduce((latest, unit) => (unit.order > latest.order ? unit : latest)),
  );
  const sampleCommits: string[] = [];
  const sampleChanges: string[][] = [];
  for (const unit of latestPerChange.sort((a, b) => b.order - a.order)) {
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
    weightedSupport: spread.weightedSupport,
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
