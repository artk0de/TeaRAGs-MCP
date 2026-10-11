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
 * Changes sharing an author burst count as one when either is taskless
 * ({@link changeGroups}): the burst still stops a WIP spray of re-commits from
 * counting as many changes, but it only stands in for a task id — two changes
 * that each declare their own task stay two (bd tea-rags-mcp-zf9yz.5).
 * A burst's union is never a unit — parallel agent sessions committing under
 * one author chain unrelated commits into it, so a union spread is one no
 * single change ever touched. The units are the changes' component sets,
 * identical sets sharing a burst deduplicated (the gate's
 * distinct-pairs-per-burst). A bundle without a recorded burst is its own.
 * Only partitioned (production) files count; nothing is filtered by file type
 * or by how often a component changes.
 *
 * MECHANICAL (bd tea-rags-mcp-dm61n). A sweep — a rename, an import rewrite, a
 * flag removal — repeats one per-file (added, deleted) pattern across every
 * file it touches, and is a fan-out by construction, not evidence of one.
 * {@link classifyShotgunSurgeryMechanicalBundles} tests each commit's modal
 * line-count pair against the corpus distribution of those pairs (union
 * bound, BH), and a commit it calls mechanical leaves the WHOLE history in
 * {@link collectCommits}: degrees, bursts, opportunities, units and umbrella
 * breadth. Never weight 0 — a 0-weight unit still clears the support gate,
 * still counts as an opportunity the null expects mass from, still shrinks the
 * closure and still moves k and T, and its bursts still fit x_c; removal makes
 * the null the configuration null of the counted population, fitted on the
 * same bursts whose units are counted (THE NULL's proof carries over). The
 * classification is per commit and precedes the join, so a task's genuine
 * commits still join each other. No line counts recorded → no commit is
 * mechanical, and the summary carries none of the stage's fields.
 *
 * RETIREMENT (bd tea-rags-mcp-zf9yz.2). A change that retires code — a flag
 * removal, a dead branch deleted — walks the fan-out an earlier change wired
 * in. It closes that change's lifecycle and is no independent evidence of the
 * spread, yet neither the echo nor the lifecycle test joins it, because it
 * retires the guard and the dead branch, never exactly the lines the feature
 * added. {@link classifyShotgunSurgeryRetirementUnits} sums each unit's
 * per-file net over its commits and calls it retiring when its net-negative
 * files exceed the corpus rate (binomial tail, BH over the wide units an
 * all-negative change of their size could reject at all). Inside a spread a
 * retiring change counts only as the spread's OLDEST supporting change — then
 * it retires nothing the spread saw. A spread left below the build's minimum
 * support of genuine changes is RETIRED: neither a finding nor an
 * explanation. Removing such changes from the history instead was measured and
 * lost 8 TRUE findings on taxdome (it moves T and the umbrella cut). No line
 * counts or no timestamps → no stage, and none of its summary fields.
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
 * bound. It measures cohesion, so it is evidence and not the order: spreads
 * rank by FAMILY EVIDENCE, −log10 of the gate's own tail bound at the
 * spread's width less log10 C(n₂, m) (bd tea-rags-mcp-zf9yz.1). Measured on
 * taxdome's gold set (44 reproducible items): AUC 0.53 by strength — a block
 * born and edited only inside one feature tops it — against 0.77 by family
 * evidence. Pure: ports in, verdicts out; no bundle membership → nothing
 * judged, never zeros posing as verdicts.
 */

import type { CochangeFileLineCounts, RelPath } from "../../../../../contracts/types/codegraph.js";
import { resolveMajorityFlooredOtsuThreshold } from "../../../../../primitives/graph/index.js";
import {
  binomialUpperTail,
  mulberry32,
  poissonBinomialUpperTail,
  seedFromKey,
} from "../../../../../primitives/math/index.js";
import { compilePathPatternMatcher } from "../../../../../primitives/paths/index.js";
import { componentAncestry } from "../../component-geometry/index.js";
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

/**
 * Besag–Clifford stop for the echo permutation test: sampling ends at this
 * many permutations scoring at least the observed mirror, p = h / k. Ten keeps
 * the p of a null-like pair within a factor of ~1.4 while spending almost
 * nothing on it; only a pair near the floor runs to the cap ⌈m / q⌉.
 */
export const SHOTGUN_SURGERY_ECHO_EXCEEDANCES = 10;

/** Positions! up to this (8! — |U| ≤ 8) the echo p-value is enumerated exactly instead of sampled. */
export const SHOTGUN_SURGERY_ECHO_EXACT_PERMUTATIONS = 40_320;

/** Relative tie tolerance of the echo statistic: a permutation scoring within it of the observed exceeds (conservative). */
const ECHO_SCORE_TOLERANCE = 1e-12;

/** Relative size below which the remaining union-bound terms are added as one bound and the sum stops. */
const MODAL_UNIFORMITY_REMAINDER_RELATIVE = 1e-9;

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
  /**
   * The +/- line counts each bundle's commit made to its files, keyed like
   * `bundles` — by bundle id — then by the file's path, the same `RelPath` the
   * bundle's membership list and `componentOf` use (bd tea-rags-mcp-dm61n),
   * HEAD-attributed with renames summed onto the head path. A file with no
   * recorded count (binary) is absent from its bundle's map. A bundle absent
   * from the map has unknown line counts: never mechanical, never in an echo
   * pair. The whole map absent or empty = not recorded (the build predates
   * migration 046): neither the mechanical nor the echo stage runs, and their
   * summary fields are absent, never zeros.
   */
  bundleFileLines?: ReadonlyMap<number, ReadonlyMap<RelPath, CochangeFileLineCounts>>;
  /**
   * Unix seconds of each bundle's commit, keyed by bundle id — the chronology
   * the lifecycle test orients pairs and file revisits by (bd
   * tea-rags-mcp-zf9yz). Bundle ids are a storage detail and never stand in
   * for it. A bundle absent from the map is in no lifecycle pair and no
   * revisit. The whole map absent or empty = not recorded (a build predating
   * migration 047): no lifecycle stage, and its summary fields are absent.
   * Recency elsewhere (the sample commits) then falls back to the store's
   * numbering, which `extractCochangeGraph` assigns newest first: the smallest
   * id is the newest commit (bd tea-rags-mcp-dlvyi).
   */
  bundleTimestamps?: ReadonlyMap<number, number>;
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
  /**
   * {@link cochangeStrength} over support and the least- / most-changed
   * component. It reads COHESION — its maximum goes to a member that never
   * changed outside the spread — so it is evidence, not the ranking.
   */
  strength: number;
  /**
   * The ranking: −log10 p(S) − log10 C(n₂, m). p(S) is the gate's own
   * compound-Poisson tail bound for this spread at its own width m, n₂ the
   * components changed in ≥ 2 bursts — the spread's surprise after paying for
   * every set of its width, i.e. −log10 of its Bonferroni-adjusted p within m,
   * unbounded. A block of members that only ever change together earns a tiny
   * p from its width alone; the C(n₂, m) charge takes that back. Both terms
   * are computed in log space, so it stays finite where p underflows.
   */
  familyEvidence: number;
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
  /**
   * Commits that held the spread, the newest commit of each of the newest
   * supporting changes, newest first (≤ {@link SHOTGUN_SURGERY_SAMPLE_COMMITS}).
   * Recency is `ShotgunSurgeryInput.bundleTimestamps`, else the store's
   * newest-first bundle numbering.
   */
  sampleCommits: string[];
  /**
   * The logical change behind each sample commit, aligned with `sampleCommits`:
   * every commit of the change that held the spread, newest first.
   */
  sampleChanges: string[][];
}

export interface ShotgunSurgerySummary {
  /** Author bursts touching ≥ 1 partitioned component through a non-mechanical commit — the support unit. */
  burstCount: number;
  /** Commits tested for line-count uniformity (≥ 3 components and ≥ 3 line-counted files) — the BH family. Absent = line counts not recorded. */
  mechanicalTestedCount?: number;
  /** Commits BH called mechanical, left out of the whole history (degrees, units, umbrella breadth). Absent = line counts not recorded. */
  mechanicalCommitCount?: number;
  /** Non-mechanical wide commit pairs sharing ≥ 3 components — the echo BH family m. Absent = line counts not recorded. */
  echoCandidatePairCount?: number;
  /** Pairs BH called echoes (a revert or flag removal and its original), joined into one logical change. Absent = line counts not recorded. */
  echoPairCount?: number;
  /** Non-mechanical wide commit pairs sharing ≥ 3 components — the lifecycle BH family m (equals `echoCandidatePairCount`). Absent = line counts or commit timestamps not recorded. */
  lifecycleCandidatePairCount?: number;
  /** Pairs BH called lifecycle (the newer exactly retires lines the older added), joined into one logical change. Absent = line counts or commit timestamps not recorded. */
  lifecyclePairCount?: number;
  /** Wide units an all-negative change of their file count could reject — the retirement BH family. Absent = line counts or commit timestamps not recorded. */
  retirementTestedCount?: number;
  /** Units BH called retiring (net-negative files beyond the corpus rate). Absent = line counts or commit timestamps not recorded. */
  retirementUnitCount?: number;
  /** Spreads whose genuine support fell below the minimum once newer retiring changes were discounted — {@link ShotgunSurgeryReport.retired}. Absent = line counts or commit timestamps not recorded. */
  retiredSpreadCount?: number;
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
  /**
   * Explained spreads only a dependency chain through a genuine supporting
   * change's footprint joins (see {@link ShotgunSurgeryStructure}) — without
   * that join they would be findings. Part of `explainedCount`.
   */
  chainExplainedCount: number;
  violationCount: number;
  sharedNeighbourThreshold?: number;
  /** `none` = the neighbour weights allowed no Otsu cut; only direct dependencies explained. */
  sharedNeighbourThresholdMethod: "otsu" | "none";
  /** Unexplained spreads with no exemplar file matching `sourcePathPattern`; present only when scoped. */
  outOfScopeSetCount?: number;
}

export interface ShotgunSurgeryReport {
  /** Unexplained recurring wide spreads, most surprising first ({@link ShotgunSurgerySpread.familyEvidence}). */
  findings: ShotgunSurgerySpread[];
  /** Spreads one structural island explains, most surprising first. */
  explained: ShotgunSurgerySpread[];
  /**
   * Spreads whose support is a newer change retiring code plus too few genuine
   * changes (see RETIREMENT in the module docblock), most surprising first —
   * neither findings nor explanations. Empty when the stage did not run.
   */
  retired: ShotgunSurgerySpread[];
  summary: ShotgunSurgerySummary;
}

/** One counted unit: a logical change's component set (identical sets sharing a burst once). */
interface ShotgunSurgeryUnit {
  /** Indices of the author bursts the unit's commits fall in, ascending. */
  bursts: number[];
  components: Set<string>;
  filesByComponent: Map<string, Set<RelPath>>;
  /** The unit's newest commit ({@link bundleChronology}) — its sample commit. */
  newestBundleId: number;
  /** Chronological position of the unit's newest commit (0 = the history's oldest commit). */
  newestPosition: number;
  /** The bundles (one commit each) of the change units with this component set, newest first. */
  bundleIds: number[];
  /**
   * The non-umbrella task ids the unit's commits declare, ascending. Empty =
   * a taskless unit: only its burst says which change it belongs to
   * ({@link changeGroups}).
   */
  taskIds: string[];
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
  /** The echo test's outcome; absent when no line counts were recorded. */
  echo: ShotgunSurgeryEchoAssessment | undefined;
  /** The lifecycle test's outcome; absent when line counts or commit timestamps were not recorded. */
  lifecycle: ShotgunSurgeryLifecycleAssessment | undefined;
  chronology: ShotgunSurgeryChronology;
}

/** The counted commits in time ({@link bundleChronology}) and what each touched. */
interface ShotgunSurgeryChronology {
  /** 0 = the history's oldest counted commit. */
  positionOf: (bundleId: number) => number;
  /** Whether the commit edited a partitioned file of one of `components`. */
  touches: (bundleId: number, components: ReadonlySet<string>) => boolean;
}

interface AdmittedSpread {
  components: string[];
  support: number;
  weightedSupport: number;
  expectedSupport: number;
  /** ln of the gate's tail bound for the spread at its own width — the ranking's p(S), kept in log space. */
  logTailBound: number;
  /** The commits (per-commit sets) that held the spread. */
  supporting: ShotgunSurgeryUnit[];
}

/** Judge the history's wide changes. See the module docblock for every contract. */
export function detectShotgunSurgery(input: ShotgunSurgeryInput): ShotgunSurgeryReport {
  const mechanical = lineCountsRecorded(input) ? classifyShotgunSurgeryMechanicalBundles(input) : undefined;
  const { units, burstCount, changes, burstWidths, umbrella, echo, lifecycle, chronology } = buildHistory(
    input,
    mechanical?.bundleIds ?? new Set(),
  );
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
    ({ components, unitIndices, support }) => {
      const weightedSupport = weightedSupportOf(wide, unitIndices, components.length, specificity);
      const nullTerms = propensity.weightedNull(components);
      return {
        components,
        support,
        weightedSupport,
        expectedSupport: expectedWeightedSupport(nullTerms),
        logTailBound: compoundPoissonUpperTailLogBound(weightedSupport, nullTerms),
        supporting: unitIndices.map((index) => wide[index]),
      };
    },
  );

  const structure = new ShotgunSurgeryStructure(
    input.componentDependencies,
    input.componentOf,
    new ShotgunSurgeryFeatureSubtrees(changes.keys(), specificity.typicalWidth),
  );
  const islandsOf = structure.islandResolver(closed.map((spread) => spread.components));
  const retirement =
    lineCountsRecorded(input) && timestampsRecorded(input)
      ? classifyShotgunSurgeryRetirementUnits(units, widthThreshold, input)
      : undefined;
  const inScope = compilePathPatternMatcher(input.sourcePathPattern);
  let outOfScopeSetCount = 0;
  let chainExplainedCount = 0;
  const findings: ShotgunSurgerySpread[] = [];
  const explained: ShotgunSurgerySpread[] = [];
  const retired: ShotgunSurgerySpread[] = [];
  for (const spread of closed) {
    const genuine = retirement ? genuineChanges(spread, retirement.units, chronology) : undefined;
    const footprint = changeFootprint(genuine ? genuine.flat() : spread.supporting);
    const shaped = shapeSpread(
      spread,
      changes,
      changedTwice,
      islandsOf.islands(spread.components, footprint),
      input.bundleCommits,
    );
    if (genuine && genuine.length < TEMPORAL_COCHANGE_MIN_SUPPORT) {
      retired.push(shaped);
      continue;
    }
    if (shaped.islands.length <= 1) {
      if (islandsOf.islands(spread.components, NO_FOOTPRINT).length > 1) chainExplainedCount++;
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
  retired.sort(compareSpreads);

  return {
    findings,
    explained,
    retired,
    summary: {
      burstCount,
      ...(mechanical === undefined
        ? {}
        : { mechanicalTestedCount: mechanical.testedCount, mechanicalCommitCount: mechanical.bundleIds.size }),
      ...(echo === undefined
        ? {}
        : { echoCandidatePairCount: echo.candidatePairCount, echoPairCount: echo.pairs.length }),
      ...(lifecycle === undefined
        ? {}
        : { lifecycleCandidatePairCount: lifecycle.candidatePairCount, lifecyclePairCount: lifecycle.pairs.length }),
      ...(retirement === undefined
        ? {}
        : {
            retirementTestedCount: retirement.testedCount,
            retirementUnitCount: retirement.units.size,
            retiredSpreadCount: retired.length,
          }),
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
      chainExplainedCount,
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
 * burst (first-seen order); a bundle without a recorded burst is its own. A
 * bundle in `excluded` (a mechanical commit) is skipped exactly like one with
 * no partitioned file: no burst index, no degree, no unit.
 */
function collectCommits(
  input: ShotgunSurgeryInput,
  excluded: ReadonlySet<number>,
): { commits: ShotgunSurgeryCommit[]; burstCount: number } {
  const burstIndex = new Map<string, number>();
  const commits: ShotgunSurgeryCommit[] = [];
  for (const [bundleId, files] of input.bundles) {
    if (excluded.has(bundleId)) continue;
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
 * task id and joins here. Anything else is caught by the inverse-diff
 * evidence: {@link findShotgunSurgeryEchoPairs} tests whether one commit's
 * per-file net lines mirror another's beyond chance (permutation null, BH),
 * and every echo pair it admits unions here like a shared task id — whatever
 * task ids either side carries, so a revert under a different id becomes one
 * change with its original. An echo JOINS, never zeroes: zeroing a revert
 * would drop its original's evidence too. Umbrella ids still never join.
 * Without line counts there are no echo pairs, and an echo without a shared
 * task id counts as a second change.
 *
 * LIFECYCLES (bd tea-rags-mcp-zf9yz) — a feature introduced, then retired by a
 * later commit (a scope cut, a flag removal, a revert-redo) — are one change
 * too, even when the retirement mirrors only part of the original and so
 * escapes the echo test. {@link findShotgunSurgeryLifecyclePairs} counts the
 * shared files where the newer commit's net is exactly the negation of a
 * positive net the older one added, against a null that is the larger of the
 * corpus revisit rate and the file's own rate of that value
 * ({@link ShotgunSurgeryLifecycleNull}), Poisson-binomial, BH. Its pairs union
 * here exactly like echoes and task ids. A lifecycle JOINS, never removes:
 * retiring a scattered feature touches exactly the places it was wired into,
 * so the removal is shotgun evidence, and only counting it as a second change
 * was wrong.
 */
function joinLogicalChanges(
  commits: readonly ShotgunSurgeryCommit[],
  umbrella: ShotgunSurgeryUmbrellaTaskIds,
  joinedPairs: readonly ShotgunSurgeryJoinedPair[],
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
  if (joinedPairs.length > 0) {
    const indexOf = new Map(commits.map(({ bundleId }, index) => [bundleId, index]));
    for (const { first, second } of joinedPairs) {
      const a = indexOf.get(first);
      const b = indexOf.get(second);
      if (a !== undefined && b !== undefined) joins.union(a, b);
    }
  }
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
function buildHistory(input: ShotgunSurgeryInput, mechanical: ReadonlySet<number>): ShotgunSurgeryHistory {
  const { commits, burstCount } = collectCommits(input, mechanical);
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
  const echo = lineCountsRecorded(input) ? findShotgunSurgeryEchoPairs(commits, input) : undefined;
  const lifecycle =
    lineCountsRecorded(input) && timestampsRecorded(input)
      ? findShotgunSurgeryLifecyclePairs(commits, umbrella, input)
      : undefined;
  const changeUnits = joinLogicalChanges(commits, umbrella, [...(echo?.pairs ?? []), ...(lifecycle?.pairs ?? [])]);
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
        newestBundleId: bundleIds[0],
        newestPosition: 0,
        bundleIds: [...bundleIds],
        taskIds: [],
      });
      return;
    }
    unit.bundleIds.push(...bundleIds);
    unit.bursts.push(...bursts);
    mergeFiles(unit.filesByComponent, filesByComponent);
  });
  const units = [...merged.values()];
  const chronology = bundleChronology(input);
  const position = new Map(
    commits
      .map(({ bundleId }) => bundleId)
      .sort(chronology)
      .map((bundleId, index) => [bundleId, index]),
  );
  const positionOf = (bundleId: number): number => position.get(bundleId) ?? 0;
  const taskIdsOf = new Map(commits.map(({ bundleId, taskIds }) => [bundleId, taskIds]));
  for (const unit of units) {
    const declared = new Set<string>();
    for (const bundleId of unit.bundleIds) {
      for (const taskId of taskIdsOf.get(bundleId) ?? []) if (!umbrella.ids.has(taskId)) declared.add(taskId);
    }
    unit.taskIds = [...declared].sort(compareCodePoints);
    unit.bundleIds.sort((a, b) => positionOf(b) - positionOf(a));
    unit.newestBundleId = unit.bundleIds[0];
    unit.newestPosition = positionOf(unit.bundleIds[0]);
    unit.bursts = [...new Set(unit.bursts)].sort((a, b) => a - b);
  }
  const componentsOf = new Map(commits.map(({ bundleId, filesByComponent }) => [bundleId, filesByComponent]));
  const chronologyOfHistory: ShotgunSurgeryChronology = {
    positionOf,
    touches: (bundleId, components) => [...(componentsOf.get(bundleId)?.keys() ?? [])].some((c) => components.has(c)),
  };
  return { units, burstCount, changes, burstWidths, umbrella, echo, lifecycle, chronology: chronologyOfHistory };
}

/**
 * Older-first order of bundles (bd tea-rags-mcp-dlvyi): by `bundleTimestamps`,
 * the smaller first SHA older on a tie. With no timestamps recorded the store's
 * numbering stands in — `extractCochangeGraph` numbers bundles newest first, so
 * the larger id is the older commit. A bundle the recorded map does not date
 * sorts as time 0, the oldest.
 */
function bundleChronology(
  input: Pick<ShotgunSurgeryInput, "bundleCommits" | "bundleTimestamps">,
): (a: number, b: number) => number {
  const timestamps = input.bundleTimestamps;
  if (!timestamps || timestamps.size === 0) return (a, b) => b - a;
  return (a, b) =>
    (timestamps.get(a) ?? 0) - (timestamps.get(b) ?? 0) ||
    compareCodePoints(bundleSortKey(input, a), bundleSortKey(input, b)) ||
    b - a;
}

/** A bundle's first SHA, or `bundle:<id>` when none is recorded — the tie-break key of every chronology and sort. */
function bundleSortKey(input: Pick<ShotgunSurgeryInput, "bundleCommits">, bundleId: number): string {
  return input.bundleCommits?.get(bundleId)?.[0] ?? `bundle:${bundleId}`;
}

/**
 * Whether the build recorded line counts at all: absent OR empty is a build
 * predating migration 046 (the store reads an empty map there), and then
 * neither the mechanical nor the echo stage runs.
 */
function lineCountsRecorded(input: Pick<ShotgunSurgeryInput, "bundleFileLines">): boolean {
  return (input.bundleFileLines?.size ?? 0) > 0;
}

/** Whether the build recorded commit timestamps: absent OR empty is a build predating migration 047 — no lifecycle stage. */
function timestampsRecorded(input: Pick<ShotgunSurgeryInput, "bundleTimestamps">): boolean {
  return (input.bundleTimestamps?.size ?? 0) > 0;
}

/** The units BH called retiring, and the family it tested. */
interface ShotgunSurgeryRetirementClassification {
  units: ReadonlySet<ShotgunSurgeryUnit>;
  /** Wide units with ≥ {@link shotgunSurgeryRetirementMinFiles} nonzero-net files — the BH family. */
  testedCount: number;
}

/**
 * RETIREMENT — a change whose files go net-negative more often than the
 * corpus's do. Per unit: its partitioned line-counted files' nets summed over
 * its commits; n = files with a nonzero net, x = those below zero. p₀ = Σx / Σn
 * over EVERY unit — the corpus rate. p = P(Bin(n, p₀) ≥ x). Family: the units a
 * spread can stand on (≥ `widthThreshold` components) whose n reaches
 * {@link shotgunSurgeryRetirementMinFiles} — below it even an all-negative
 * change cannot reach p ≤ q, so testing it would only dilute BH. Both cuts are
 * the corpus's own. BH at {@link COCHANGE_SIGNIFICANCE_FDR_Q}.
 */
function classifyShotgunSurgeryRetirementUnits(
  units: readonly ShotgunSurgeryUnit[],
  widthThreshold: number,
  input: Pick<ShotgunSurgeryInput, "bundleFileLines" | "componentOf">,
): ShotgunSurgeryRetirementClassification {
  const lines = input.bundleFileLines ?? new Map<number, ReadonlyMap<RelPath, CochangeFileLineCounts>>();
  let negative = 0;
  let nonzero = 0;
  const profiles = units.map((unit) => {
    const net = new Map<RelPath, number>();
    for (const bundleId of unit.bundleIds) {
      for (const [relPath, row] of lines.get(bundleId) ?? []) {
        if (input.componentOf.get(relPath) === undefined) continue;
        net.set(relPath, (net.get(relPath) ?? 0) + row.added - row.deleted);
      }
    }
    let files = 0;
    let retiring = 0;
    for (const value of net.values()) {
      if (value === 0) continue;
      files++;
      if (value < 0) retiring++;
    }
    negative += retiring;
    nonzero += files;
    return { unit, files, retiring };
  });
  if (nonzero === 0) return { units: new Set(), testedCount: 0 };
  const share = negative / nonzero;
  const minFiles = shotgunSurgeryRetirementMinFiles(share, COCHANGE_SIGNIFICANCE_FDR_Q);
  const tested = profiles
    .filter(({ unit, files }) => unit.components.size >= widthThreshold && files >= minFiles)
    .map(({ unit, files, retiring }) => ({ unit, p: binomialUpperTail(retiring, files, share) }));
  tested.sort((a, b) => a.p - b.p || a.unit.newestPosition - b.unit.newestPosition);
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((t) => t.p),
    tested.length,
  );
  return { units: new Set(tested.slice(0, rejected).map((t) => t.unit)), testedCount: tested.length };
}

/**
 * The fewest nonzero-net files at which a change retiring on EVERY file can
 * reach p = `netNegativeShare`ⁿ ≤ `q` — BH rejects nothing above q, so a
 * smaller change is untestable. Derived from the corpus rate, never a
 * constant; +∞ when every counted file went net-negative.
 */
export function shotgunSurgeryRetirementMinFiles(netNegativeShare: number, q: number): number {
  if (netNegativeShare >= 1) return Number.POSITIVE_INFINITY;
  let files = 1;
  while (netNegativeShare ** files > q) files++;
  return files;
}

/**
 * A spread's distinct supporting changes ({@link changeGroups}) less the
 * retiring ones newer than another — a change all of whose units retire code
 * counts only when it is the spread's oldest supporting change. A change's age
 * here is its oldest commit touching the spread: a task whose first commit
 * edited elsewhere still reached the spread when that commit did.
 */
function genuineChanges(
  spread: AdmittedSpread,
  retiring: ReadonlySet<ShotgunSurgeryUnit>,
  history: ShotgunSurgeryChronology,
): ShotgunSurgeryUnit[][] {
  const members = new Set(spread.components);
  const touchedAt = (unit: ShotgunSurgeryUnit): number =>
    Math.min(
      ...unit.bundleIds
        .filter((bundleId) => history.touches(bundleId, members))
        .map((bundleId) => history.positionOf(bundleId)),
    );
  const groups = changeGroups(
    spread.supporting,
    spread.supporting.map((_, index) => index),
  ).map((group) => ({
    units: group.map((index) => spread.supporting[index]),
    retiring: group.every((index) => retiring.has(spread.supporting[index])),
    oldest: Math.min(...group.map((index) => touchedAt(spread.supporting[index]))),
  }));
  const oldest = Math.min(...groups.map((group) => group.oldest));
  return groups.filter((group) => !group.retiring || group.oldest === oldest).map((group) => group.units);
}

/**
 * The components a spread's genuine supporting changes touched — every
 * supporting unit's whole component set, the {@link genuineChanges} only when
 * the retirement stage ran. What {@link ShotgunSurgeryStructure} lets a chain
 * pass through.
 */
function changeFootprint(units: readonly ShotgunSurgeryUnit[]): Set<string> {
  const footprint = new Set<string>();
  for (const unit of units) for (const component of unit.components) footprint.add(component);
  return footprint;
}

/** Commits the uniformity test calls mechanical, and the family it tested. */
export interface ShotgunSurgeryMechanicalClassification {
  bundleIds: ReadonlySet<number>;
  /** Commits with ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH} components and ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH} line-counted files — the BH family. */
  testedCount: number;
}

/**
 * MECHANICAL — a sweep's per-file line counts are one pattern repeated
 * (rename, import rewrite, flag removal). Rows = the commit's partitioned
 * files with line counts, each keyed by its exact (added, deleted) pair.
 * π = the corpus distribution of those keys over EVERY commit's rows.
 * Statistic c = the commit's modal key count over n rows. Null: rows iid from
 * π. p = min(1, Σ_v P(Bin(n, π_v) ≥ c)) — the union bound on the multinomial
 * max ({@link shotgunSurgeryModalUniformityPValue}); c < 2 → p = 1. BH at
 * {@link COCHANGE_SIGNIFICANCE_FDR_Q} over the tested commits. A bundle the
 * line-count map does not hold is never tested.
 */
export function classifyShotgunSurgeryMechanicalBundles(
  input: Pick<ShotgunSurgeryInput, "bundles" | "componentOf" | "bundleFileLines">,
): ShotgunSurgeryMechanicalClassification {
  const lines = input.bundleFileLines;
  if (!lines) return { bundleIds: new Set(), testedCount: 0 };
  const keyCounts = new Map<string, number>();
  let rowTotal = 0;
  const profiles: { bundleId: number; rows: number; modal: number }[] = [];
  for (const [bundleId, files] of input.bundles) {
    const counts = lines.get(bundleId);
    if (!counts) continue;
    const components = new Set<string>();
    const own = new Map<string, number>();
    let rows = 0;
    for (const relPath of files) {
      const component = input.componentOf.get(relPath);
      if (component === undefined) continue;
      components.add(component);
      const row = counts.get(relPath);
      if (!row) continue;
      const key = `${row.added},${row.deleted}`;
      own.set(key, (own.get(key) ?? 0) + 1);
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      rows++;
    }
    rowTotal += rows;
    if (components.size < SHOTGUN_SURGERY_MIN_WIDTH || rows < SHOTGUN_SURGERY_MIN_WIDTH) continue;
    profiles.push({ bundleId, rows, modal: Math.max(...own.values()) });
  }
  const shares = [...keyCounts.values()].map((count) => count / rowTotal).sort((a, b) => b - a);
  const tested = profiles.map(({ bundleId, rows, modal }) => ({
    bundleId,
    p: shotgunSurgeryModalUniformityPValue(rows, modal, shares),
  }));
  tested.sort((a, b) => a.p - b.p || a.bundleId - b.bundleId);
  const rejected = benjaminiHochbergRejectionCount(
    tested.map((t) => t.p),
    tested.length,
  );
  return { bundleIds: new Set(tested.slice(0, rejected).map((t) => t.bundleId)), testedCount: tested.length };
}

/**
 * Σ_v P(Bin(n, π_v) ≥ c) over the shares sorted descending, as a valid upper
 * bound: once term_i · (remaining shares) < sum · 1e-9, add term_i ·
 * (remaining) — each later term is ≤ term_i because the tail rises with π —
 * and stop. The remainder is bounded, never dropped. Clamped to 1; c < 2 → 1.
 */
export function shotgunSurgeryModalUniformityPValue(
  rowCount: number,
  modalCount: number,
  sharesDescending: readonly number[],
): number {
  if (modalCount < 2) return 1;
  let sum = 0;
  for (let i = 0; i < sharesDescending.length; i++) {
    const term = binomialUpperTail(modalCount, rowCount, sharesDescending[i]);
    sum += term;
    const remaining = sharesDescending.length - i - 1;
    if (term * remaining < sum * MODAL_UNIFORMITY_REMAINDER_RELATIVE) {
      sum += term * remaining;
      break;
    }
    if (sum >= 1) return 1;
  }
  return Math.min(1, sum);
}

/** An echo: two commits that are one logical event (an original and its revert / flag removal). */
export interface ShotgunSurgeryEchoPair {
  /** The smaller bundle id. */
  first: number;
  /** The larger bundle id. */
  second: number;
  /** The pair's permutation p-value. */
  pValue: number;
}

export interface ShotgunSurgeryEchoAssessment {
  /** The pairs BH admitted at {@link COCHANGE_SIGNIFICANCE_FDR_Q} — the joined echoes. */
  pairs: ShotgunSurgeryEchoPair[];
  /** Every tested pair, by (p, first, second); `pairs` is its admitted prefix. */
  candidates: ShotgunSurgeryEchoPair[];
  /** m — the BH family. */
  candidatePairCount: number;
}

/** A commit as the echo test reads it: its bundle and its partitioned files. */
export interface ShotgunSurgeryEchoCommit {
  bundleId: number;
  filesByComponent: ReadonlyMap<string, ReadonlySet<RelPath>>;
}

/**
 * ECHO — a revert or flag removal mirrors an earlier commit's per-file net
 * lines. Population: the given (non-mechanical) commits with recorded line
 * counts spanning ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH} components — the
 * constant, not k, since k is drawn from the units the join shapes.
 * Candidates: pairs sharing ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH} components.
 * Statistic: {@link shotgunSurgeryMirroredNetShare} over U = files either
 * changed, net = added − deleted, zero-padded on U. Null: given one side's
 * vector, every assignment of the other side's values to U's positions is
 * equally likely ({@link shotgunSurgeryEchoPermutationPValue}), with the
 * sampling cap B = ⌈m / q⌉ so the floor 1 / (B + 1) clears BH at any rank.
 * BH over all m candidates. Determinism: the side held fixed, U's order and
 * the RNG seed all derive from the two bundles' first commit SHAs (bundle ids
 * when no SHA is recorded), so the p-value is independent of evaluation order
 * and of how a rebuild numbers the bundles.
 */
export function findShotgunSurgeryEchoPairs(
  commits: readonly ShotgunSurgeryEchoCommit[],
  input: Pick<ShotgunSurgeryInput, "bundleFileLines" | "bundleCommits">,
): ShotgunSurgeryEchoAssessment {
  const { nets, pairs } = shotgunSurgeryWideCommitPairs(commits, input);
  const m = pairs.length;
  const maxPermutations = Math.ceil(m / COCHANGE_SIGNIFICANCE_FDR_Q);
  const keyOf = (bundleId: number): string => input.bundleCommits?.get(bundleId)?.[0] ?? `bundle:${bundleId}`;
  const candidates: ShotgunSurgeryEchoPair[] = pairs.map(([first, second]) => {
    // Orient by the data, never by the bundle numbering: the side with the
    // smaller key is held fixed, and the key pair seeds the RNG.
    const [fixedId, permutedId] =
      compareCodePoints(keyOf(first), keyOf(second)) <= 0 ? [first, second] : [second, first];
    const fixed = nets.get(fixedId) ?? new Map<RelPath, number>();
    const permuted = nets.get(permutedId) ?? new Map<RelPath, number>();
    const positions = [...new Set([...fixed.keys(), ...permuted.keys()])].sort(compareCodePoints);
    const random = mulberry32(seedFromKey(`${keyOf(fixedId)}\u0000${keyOf(permutedId)}`));
    const pValue = shotgunSurgeryEchoPermutationPValue(
      positions.map((relPath) => fixed.get(relPath) ?? 0),
      positions.map((relPath) => permuted.get(relPath) ?? 0),
      random,
      { exceedances: SHOTGUN_SURGERY_ECHO_EXCEEDANCES, maxPermutations },
    );
    return { first, second, pValue };
  });
  candidates.sort((a, b) => a.pValue - b.pValue || a.first - b.first || a.second - b.second);
  const rejected = benjaminiHochbergRejectionCount(
    candidates.map((c) => c.pValue),
    m,
  );
  return { pairs: candidates.slice(0, rejected), candidates, candidatePairCount: m };
}

/**
 * The mirrored share of two aligned net vectors:
 * Σ_{x_f·y_f < 0} min(|x_f|, |y_f|) / Σ_f max(|x_f|, |y_f|) — 0 when both are
 * empty. Only opposite-sign mass counts, so file overlap alone never scores.
 */
export function shotgunSurgeryMirroredNetShare(first: readonly number[], second: readonly number[]): number {
  let mirrored = 0;
  let mass = 0;
  for (let i = 0; i < first.length; i++) {
    const a = first[i];
    const b = second[i];
    if (a * b < 0) mirrored += Math.min(Math.abs(a), Math.abs(b));
    mass += Math.max(Math.abs(a), Math.abs(b));
  }
  return mass === 0 ? 0 : mirrored / mass;
}

/**
 * P(score(first, π·second) ≥ observed) under uniform π over positions: exact
 * (Heap's algorithm) when positions! ≤ {@link SHOTGUN_SURGERY_ECHO_EXACT_PERMUTATIONS},
 * else Besag–Clifford sequential Monte Carlo over Fisher–Yates shuffles —
 * p = h / k at the `exceedances`-th exceedance, (g + 1) / (B + 1) at the
 * `maxPermutations` cap. A score within {@link ECHO_SCORE_TOLERANCE} of the
 * observed exceeds (ties count against the pair). Observed 0 → 1, no sampling.
 * Both forms are super-uniform.
 */
export function shotgunSurgeryEchoPermutationPValue(
  first: readonly number[],
  second: readonly number[],
  random: () => number,
  options: { exceedances: number; maxPermutations: number },
): number {
  const observed = shotgunSurgeryMirroredNetShare(first, second);
  if (observed === 0) return 1;
  const threshold = observed - ECHO_SCORE_TOLERANCE;
  const n = second.length;
  const permuted = [...second];
  if (factorialAtMost(n, SHOTGUN_SURGERY_ECHO_EXACT_PERMUTATIONS)) {
    // Heap's algorithm visits every permutation once.
    let exceeding = 0;
    let total = 0;
    const visit = (): void => {
      total++;
      if (shotgunSurgeryMirroredNetShare(first, permuted) >= threshold) exceeding++;
    };
    visit();
    const stack = new Array<number>(n).fill(0);
    for (let i = 0; i < n; ) {
      if (stack[i] < i) {
        const j = i % 2 === 0 ? 0 : stack[i];
        [permuted[j], permuted[i]] = [permuted[i], permuted[j]];
        visit();
        stack[i]++;
        i = 0;
      } else {
        stack[i] = 0;
        i++;
      }
    }
    return exceeding / total;
  }
  let exceeding = 0;
  for (let drawn = 1; drawn <= options.maxPermutations; drawn++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [permuted[i], permuted[j]] = [permuted[j], permuted[i]];
    }
    if (shotgunSurgeryMirroredNetShare(first, permuted) >= threshold) {
      exceeding++;
      if (exceeding >= options.exceedances) return exceeding / drawn;
    }
  }
  return (exceeding + 1) / (options.maxPermutations + 1);
}

/** n! ≤ limit, without overflowing. */
function factorialAtMost(n: number, limit: number): boolean {
  let product = 1;
  for (let i = 2; i <= n; i++) {
    product *= i;
    if (product > limit) return false;
  }
  return true;
}

/** Two commits the join unions into one logical change — an echo, a lifecycle. */
export interface ShotgunSurgeryJoinedPair {
  first: number;
  second: number;
}

/** The wide-commit population both line-count pair tests read, and their candidate pairs. */
export interface ShotgunSurgeryWideCommitPairs {
  /** Per wide commit: its partitioned files with a recorded count, relPath → added − deleted. */
  nets: ReadonlyMap<number, ReadonlyMap<RelPath, number>>;
  /** Pairs sharing ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH} components, the smaller bundle id first. */
  pairs: readonly (readonly [number, number])[];
}

/**
 * The echo and lifecycle tests' shared family: the given (non-mechanical)
 * commits with recorded line counts spanning ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH}
 * components — the constant, not k, since k is drawn from the units the join
 * shapes — and every pair of them sharing ≥ {@link SHOTGUN_SURGERY_MIN_WIDTH}
 * components. One builder, so the two BH families are the same m.
 */
export function shotgunSurgeryWideCommitPairs(
  commits: readonly ShotgunSurgeryEchoCommit[],
  input: Pick<ShotgunSurgeryInput, "bundleFileLines">,
): ShotgunSurgeryWideCommitPairs {
  const lines = input.bundleFileLines;
  const nets = new Map<number, Map<RelPath, number>>();
  const postings = new Map<string, number[]>();
  const wide: number[] = [];
  for (const { bundleId, filesByComponent } of commits) {
    const counts = lines?.get(bundleId);
    if (!counts || filesByComponent.size < SHOTGUN_SURGERY_MIN_WIDTH) continue;
    nets.set(bundleId, commitNets(filesByComponent, counts));
    wide.push(bundleId);
  }
  wide.sort((a, b) => a - b);
  const componentsOf = new Map(commits.map(({ bundleId, filesByComponent }) => [bundleId, filesByComponent]));
  for (const bundleId of wide) {
    for (const component of componentsOf.get(bundleId)?.keys() ?? []) {
      const list = postings.get(component);
      if (list) list.push(bundleId);
      else postings.set(component, [bundleId]);
    }
  }
  const pairs: [number, number][] = [];
  for (const first of wide) {
    const shared = new Map<number, number>();
    for (const component of componentsOf.get(first)?.keys() ?? []) {
      for (const other of postings.get(component) ?? []) {
        if (other > first) shared.set(other, (shared.get(other) ?? 0) + 1);
      }
    }
    for (const [second, count] of shared) if (count >= SHOTGUN_SURGERY_MIN_WIDTH) pairs.push([first, second]);
  }
  return { nets, pairs };
}

/** A commit's partitioned files with a recorded count, relPath → added − deleted. */
function commitNets(
  filesByComponent: ReadonlyMap<string, ReadonlySet<RelPath>>,
  counts: ReadonlyMap<RelPath, CochangeFileLineCounts>,
): Map<RelPath, number> {
  const net = new Map<RelPath, number>();
  for (const relPaths of filesByComponent.values()) {
    for (const relPath of relPaths) {
      const row = counts.get(relPath);
      if (row) net.set(relPath, row.added - row.deleted);
    }
  }
  return net;
}

/** A commit as the lifecycle test reads it: the echo commit plus what relates two commits (burst, task ids). */
export interface ShotgunSurgeryLifecycleCommit extends ShotgunSurgeryEchoCommit {
  burst: number;
  taskIds: readonly string[];
}

/** A lifecycle: an older commit adding lines and a newer one retiring exactly them on its shared files. */
export interface ShotgunSurgeryLifecyclePair {
  /** The older commit's bundle — the one that added the lines. */
  first: number;
  /** The newer commit's bundle — the one that retired them. */
  second: number;
  /** The pair's Poisson-binomial p-value ({@link shotgunSurgeryLifecyclePValue}). */
  pValue: number;
}

export interface ShotgunSurgeryLifecycleAssessment {
  /** The pairs BH admitted at {@link COCHANGE_SIGNIFICANCE_FDR_Q} — the joined lifecycles. */
  pairs: ShotgunSurgeryLifecyclePair[];
  /** Every tested pair, by (p, older SHA, newer SHA); `pairs` is its admitted prefix. */
  candidates: ShotgunSurgeryLifecyclePair[];
  /** m — the BH family, the echo test's ({@link shotgunSurgeryWideCommitPairs}). */
  candidatePairCount: number;
}

/**
 * LIFECYCLE — a later commit retiring exactly the lines an earlier one added
 * (bd tea-rags-mcp-zf9yz). Family: {@link shotgunSurgeryWideCommitPairs}, the
 * echo test's. Each pair is oriented older → newer by `bundleTimestamps`, the
 * smaller first SHA older on a tie — never by bundle id, a storage detail.
 * Files: the shared files where the older commit's net x is positive and the
 * newer's y nonzero (something introduced, then touched again — a removal
 * followed by an unrelated addition is not the hypothesis). Statistic: k = the
 * files with y = −x. p = P(≥ k mirrors) over independent files, each mirroring
 * with {@link ShotgunSurgeryLifecycleNull#mirrorProbability}; k = 0 → 1. BH at
 * {@link COCHANGE_SIGNIFICANCE_FDR_Q} over all m candidates, sorted by p then
 * the two SHAs. No RNG: the p-values depend on nets, timestamps and SHAs only.
 * A pair with a side the timestamps do not date stays in the family at p = 1.
 */
export function findShotgunSurgeryLifecyclePairs(
  commits: readonly ShotgunSurgeryLifecycleCommit[],
  umbrella: { readonly ids: ReadonlySet<string> },
  input: Pick<ShotgunSurgeryInput, "bundleFileLines" | "bundleCommits" | "bundleTimestamps">,
): ShotgunSurgeryLifecycleAssessment {
  const timestamps = input.bundleTimestamps ?? new Map<number, number>();
  const lines = input.bundleFileLines ?? new Map<number, ReadonlyMap<RelPath, CochangeFileLineCounts>>();
  const keyOf = (bundleId: number): string => bundleSortKey(input, bundleId);
  const chronology = bundleChronology(input);
  const history = commits
    .filter(({ bundleId }) => timestamps.has(bundleId) && lines.has(bundleId))
    .sort((a, b) => chronology(a.bundleId, b.bundleId))
    .map((commit) => ({
      ...commit,
      nets: commitNets(commit.filesByComponent, lines.get(commit.bundleId) ?? new Map()),
    }));
  const mirrorNull = new ShotgunSurgeryLifecycleNull(history, umbrella.ids);

  const { nets, pairs } = shotgunSurgeryWideCommitPairs(commits, input);
  const candidates: ShotgunSurgeryLifecyclePair[] = pairs.map(([a, b]) => {
    if (!timestamps.has(a) || !timestamps.has(b)) return { first: a, second: b, pValue: 1 };
    const [older, newer] = chronology(a, b) <= 0 ? [a, b] : [b, a];
    const added = nets.get(older) ?? new Map<RelPath, number>();
    const retired = nets.get(newer) ?? new Map<RelPath, number>();
    const probabilities: number[] = [];
    let mirrored = 0;
    for (const relPath of [...added.keys()].sort(compareCodePoints)) {
      const x = added.get(relPath) ?? 0;
      const y = retired.get(relPath) ?? 0;
      if (x <= 0 || y === 0) continue;
      probabilities.push(mirrorNull.mirrorProbability(relPath, x, y));
      if (y === -x) mirrored++;
    }
    return { first: older, second: newer, pValue: shotgunSurgeryLifecyclePValue(probabilities, mirrored) };
  });
  candidates.sort(
    (a, b) =>
      a.pValue - b.pValue ||
      compareCodePoints(keyOf(a.first), keyOf(b.first)) ||
      compareCodePoints(keyOf(a.second), keyOf(b.second)),
  );
  const rejected = benjaminiHochbergRejectionCount(
    candidates.map((c) => c.pValue),
    pairs.length,
  );
  return { pairs: candidates.slice(0, rejected), candidates, candidatePairCount: pairs.length };
}

/**
 * P(≥ `mirrored` of the files mirror) when each file mirrors independently
 * with its own probability — {@link poissonBinomialUpperTail}; none mirrored → 1.
 */
export function shotgunSurgeryLifecyclePValue(probabilities: readonly number[], mirrored: number): number {
  return poissonBinomialUpperTail(probabilities, mirrored);
}

/** A dated commit as the lifecycle null reads it: what relates it to another, and its per-file nets. */
interface ShotgunSurgeryLifecycleHistoryCommit {
  burst: number;
  taskIds: readonly string[];
  nets: ReadonlyMap<RelPath, number>;
}

/**
 * The lifecycle null: how likely a file revisited after a net +x is to come
 * back with exactly −x by chance. Two estimates, each valid for its own
 * question, and the test takes the LARGER (the intersection-union bound, so
 * it is conservative under both):
 *
 * - pooled(x) = (M_x + 1) / (E_x + 2) over the corpus of revisits: every
 *   partitioned file's consecutive nonzero-net commits in time order, a pair
 *   counted only when the two are unrelated (different bursts, no shared
 *   non-umbrella task id — what `joinLogicalChanges` joins on). E_x = revisits
 *   after a net x, M_x = those whose next net is −x. Rare large mirrors (±12)
 *   are priced here.
 * - fileRate(f, x, y) = max(0, c_f(−x) − [y = −x]) / (N_f − 2): the file's own
 *   rate of the value −x among its nonzero-net commits, the pair's own two
 *   excluded; 0 when N_f ≤ 2. A registry file whose history is full of −1
 *   edits makes a ±1 mirror there worthless — a pooled-only null joins two
 *   different features each adding or removing one registry line.
 */
export class ShotgunSurgeryLifecycleNull {
  private readonly revisits = new Map<number, { opportunities: number; mirrors: number }>();
  private readonly valueCounts = new Map<RelPath, Map<number, number>>();
  private readonly commitCounts = new Map<RelPath, number>();

  /** `history`: the dated commits with line counts, oldest first. */
  constructor(history: readonly ShotgunSurgeryLifecycleHistoryCommit[], umbrellaIds: ReadonlySet<string>) {
    const previous = new Map<RelPath, { index: number; net: number }>();
    history.forEach((commit, index) => {
      for (const [relPath, net] of commit.nets) {
        if (net === 0) continue;
        const values = this.valueCounts.get(relPath) ?? new Map<number, number>();
        values.set(net, (values.get(net) ?? 0) + 1);
        this.valueCounts.set(relPath, values);
        this.commitCounts.set(relPath, (this.commitCounts.get(relPath) ?? 0) + 1);
        const prior = previous.get(relPath);
        if (prior && !lifecycleRelated(history[prior.index], commit, umbrellaIds)) {
          const tally = this.revisits.get(prior.net) ?? { opportunities: 0, mirrors: 0 };
          tally.opportunities++;
          if (net === -prior.net) tally.mirrors++;
          this.revisits.set(prior.net, tally);
        }
        previous.set(relPath, { index, net });
      }
    });
  }

  /** P(the newer commit nets −`added` on `relPath` by chance) — max(pooled, the file's own rate). */
  mirrorProbability(relPath: RelPath, added: number, retired: number): number {
    const tally = this.revisits.get(added) ?? { opportunities: 0, mirrors: 0 };
    const pooled = (tally.mirrors + 1) / (tally.opportunities + 2);
    const others = (this.commitCounts.get(relPath) ?? 0) - 2;
    if (others <= 0) return pooled;
    const mirrorsElsewhere = (this.valueCounts.get(relPath)?.get(-added) ?? 0) - (retired === -added ? 1 : 0);
    return Math.max(pooled, Math.max(0, mirrorsElsewhere) / others);
  }
}

/** Same burst, or a shared task id outside the umbrella ids — the relation `joinLogicalChanges` joins on. */
function lifecycleRelated(
  a: ShotgunSurgeryLifecycleHistoryCommit,
  b: ShotgunSurgeryLifecycleHistoryCommit,
  umbrellaIds: ReadonlySet<string>,
): boolean {
  if (a.burst === b.burst) return true;
  return a.taskIds.some((taskId) => !umbrellaIds.has(taskId) && b.taskIds.includes(taskId));
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
 * The units at `indices` grouped into distinct changes. A task id declares
 * which logical change a commit belongs to; a shared author burst is only the
 * stand-in where there is none (bd tea-rags-mcp-zf9yz.5). So two units sharing
 * a burst are one change only when at least one of them is taskless (a WIP
 * spray, or a commit nothing declared), transitively — a taskless unit
 * bridges every unit of its burst. Units that both declare a task are never
 * fused by the burst: units at distinct indices never share a non-umbrella
 * task id (the join already merged those), so their ids are disjoint and they
 * name different changes. Linear: per burst, either every holder joins one
 * taskless anchor, or none joins.
 */
function changeGroups(units: readonly ShotgunSurgeryUnit[], indices: readonly number[]): number[][] {
  const joins = new DisjointSets(indices.length);
  const tasklessAnchor = new Map<number, number>();
  indices.forEach((index, position) => {
    if (units[index].taskIds.length > 0) return;
    for (const burst of units[index].bursts) {
      const anchor = tasklessAnchor.get(burst);
      if (anchor === undefined) tasklessAnchor.set(burst, position);
      else joins.union(anchor, position);
    }
  });
  indices.forEach((index, position) => {
    if (units[index].taskIds.length === 0) return;
    for (const burst of units[index].bursts) {
      const anchor = tasklessAnchor.get(burst);
      if (anchor !== undefined) joins.union(anchor, position);
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
  // One burst per unit is the common case: per burst, one change if a taskless
  // unit holds it, else one per task-declared unit ({@link changeGroups}).
  if (indices.every((index) => units[index].bursts.length === 1)) {
    const perBurst = new Map<number, number>();
    for (const index of indices) {
      const [burst] = units[index].bursts;
      const tasked = perBurst.get(burst) ?? 0;
      if (tasked < 0) continue;
      perBurst.set(burst, units[index].taskIds.length === 0 ? -1 : tasked + 1);
    }
    let changes = 0;
    for (const tasked of perBurst.values()) changes += tasked < 0 ? 1 : tasked;
    return changes;
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

/** ln C(n, k), summed term by term so it never overflows where C(n, k) itself would; 0 ≤ k ≤ n. */
function logBinomial(n: number, k: number): number {
  let total = 0;
  for (let i = 0; i < k; i++) total += Math.log((n - i) / (i + 1));
  return total;
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
  const split = splitCompoundPoissonTail(observed, terms);
  if (split === undefined) return 1;
  return Math.min(1, split.heavyMean + Math.min(1, Math.exp(split.logChernoff)));
}

/**
 * The natural log of {@link compoundPoissonUpperTailBound}, computed in log
 * space so it stays finite where the probability underflows a double
 * (≈ 1e-308) — the ranking reads a spread's surprise past that point, the
 * gate never needs to. 0 where the bound is 1.
 */
export function compoundPoissonUpperTailLogBound(observed: number, terms: readonly CompoundPoissonTerm[]): number {
  const split = splitCompoundPoissonTail(observed, terms);
  if (split === undefined) return 0;
  return Math.min(0, logSumExp([Math.log(split.heavyMean), Math.min(0, split.logChernoff)]));
}

/**
 * The bound's two halves: the mean count of events at least `observed`
 * heavy, and the log of Chernoff's bound over the lighter ones (−∞ when none
 * can contribute). Undefined at or below the expected weighted sum, where the
 * bound is 1.
 */
function splitCompoundPoissonTail(
  observed: number,
  terms: readonly CompoundPoissonTerm[],
): { heavyMean: number; logChernoff: number } | undefined {
  const live = terms.filter(({ weight, mean }) => weight > 0 && mean > 0);
  if (observed <= expectedWeightedSupport(live)) return undefined;
  let heavyMean = 0;
  const light: CompoundPoissonTerm[] = [];
  for (const term of live) {
    if (term.weight >= observed) heavyMean += term.mean;
    else light.push(term);
  }
  return { heavyMean, logChernoff: chernoffLogUpperTail(observed, light) };
}

/** log of Chernoff's bound on P(Σ weight·N ≥ observed), unclamped; −∞ when no term can contribute. */
function chernoffLogUpperTail(observed: number, terms: readonly CompoundPoissonTerm[]): number {
  if (terms.length === 0) return Number.NEGATIVE_INFINITY;
  if (observed <= expectedWeightedSupport(terms)) return 0;
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
  return -(tilt * observed - cumulant);
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

/** No change footprint: islands under the direct, shared-neighbour and feature-subtree joins alone. */
const NO_FOOTPRINT: ReadonlySet<string> = new Set();

/**
 * The links among components that explain a spread: direct dependencies,
 * specific shared neighbours, one feature subtree, and a dependency chain
 * through the change's own footprint.
 *
 * CHAIN THROUGH THE FOOTPRINT (bd tea-rags-mcp-zf9yz.3) — members a and b
 * join when a directed chain a → x → b or b → x → a exists and x lies in the
 * footprint of the spread's genuine supporting changes (every component they
 * touched, retiring changes the spread discounts left out). The change walked
 * a render or call chain and edited the link in between: a page, the panel it
 * renders through a non-member, and the card that panel renders. No constant
 * and no degree cut — a fan-in fence on x lost a sweep's removal on taxdome
 * (SG79's x has fan-in 44) without saving the one TRUE finding the join costs
 * (SG46, a sidebar registry joined through `GlobalSidebarsRegister`, accepted
 * by the owner). A common dependency or a common dependent is no chain: a
 * specific shared dependency is the shotgun mechanism itself. Measured on
 * taxdome's gold with the retirement discount: AP 0.782 → 0.806, labelled
 * precision 18/35 → 17/29, five FALSE spreads explained (SG47, SG60, SG65,
 * SG75, SG79).
 */
class ShotgunSurgeryStructure {
  private readonly linked = new Set<string>();
  private readonly dependsOn = new Map<string, Set<string>>();
  private readonly dependedOnBy = new Map<string, Set<string>>();
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
      if (sourceComponent === targetComponent) continue;
      this.linked.add(pairKey(sourceComponent, targetComponent));
      addDependency(this.dependsOn, sourceComponent, targetComponent);
      addDependency(this.dependedOnBy, targetComponent, sourceComponent);
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
    /** `footprint` = the components the spread's genuine supporting changes touched; {@link NO_FOOTPRINT} disables the chain join. */
    islands: (components: readonly string[], footprint: ReadonlySet<string>) => string[][];
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
    const joins = (a: string, b: string, footprint: ReadonlySet<string>): boolean => {
      const key = pairKey(a, b);
      if (this.linked.has(key) || this.featureSubtrees.joins(a, b)) return true;
      const weight = heaviest.get(key);
      if (policy.method === "otsu" && weight !== undefined && policy.admits(weight)) return true;
      return this.chainedThrough(a, b, footprint) || this.chainedThrough(b, a, footprint);
    };
    return {
      neighbourThreshold: policy.method === "otsu" ? policy.threshold : undefined,
      islands: (components, footprint) => {
        const parent = new Map(components.map((c) => [c, c]));
        const find = (c: string): string => {
          let root = c;
          while (parent.get(root) !== root) root = parent.get(root) ?? root;
          parent.set(c, root);
          return root;
        };
        forEachPair(components, (a, b) => {
          if (joins(a, b, footprint)) parent.set(find(a), find(b));
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

  /** Whether some x in `footprint` closes `from → x → to`. */
  private chainedThrough(from: string, to: string, footprint: ReadonlySet<string>): boolean {
    if (footprint.size === 0) return false;
    const out = this.dependsOn.get(from);
    const into = this.dependedOnBy.get(to);
    if (!out || !into) return false;
    const [scan, probe] = out.size <= into.size ? [out, into] : [into, out];
    for (const link of scan) if (probe.has(link) && footprint.has(link)) return true;
    return false;
  }
}

function addDependency(adjacency: Map<string, Set<string>>, from: string, to: string): void {
  const targets = adjacency.get(from);
  if (targets) targets.add(to);
  else adjacency.set(from, new Set([to]));
}

function shapeSpread(
  spread: AdmittedSpread,
  changes: ReadonlyMap<string, number>,
  changedTwice: number,
  islands: string[][],
  bundleCommits: ReadonlyMap<number, readonly string[]> | undefined,
): ShotgunSurgerySpread {
  const componentChanges = spread.components.map((c) => changes.get(c) ?? 0);
  const carrierFiles = spread.components.map((c) => carrierFilesOf(spread.supporting, c));
  const fewest = Math.min(...componentChanges);
  const most = Math.max(...componentChanges);
  // One unit per supporting change — its newest unit that held the spread —
  // so every sample is a distinct supporting change, never a burst's
  // re-commits crowding the others out. Recency is the chronology's
  // ({@link bundleChronology}), never the bundle numbering.
  const supporting = spread.supporting.map((_, index) => index);
  const latestPerChange = changeGroups(spread.supporting, supporting).map((group) =>
    group
      .map((index) => spread.supporting[index])
      .reduce((latest, unit) => (unit.newestPosition > latest.newestPosition ? unit : latest)),
  );
  const sampleCommits: string[] = [];
  const sampleChanges: string[][] = [];
  for (const unit of latestPerChange.sort((a, b) => b.newestPosition - a.newestPosition)) {
    if (sampleChanges.length >= SHOTGUN_SURGERY_SAMPLE_COMMITS) break;
    for (const sha of bundleCommits?.get(unit.newestBundleId) ?? []) {
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
    familyEvidence: -(spread.logTailBound + logBinomial(changedTwice, spread.components.length)) / Math.LN10,
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

/** Most surprising first ({@link ShotgunSurgerySpread.familyEvidence}), then more support, then the key. */
function compareSpreads(a: ShotgunSurgerySpread, b: ShotgunSurgerySpread): number {
  return b.familyEvidence - a.familyEvidence || b.support - a.support || compareKeys(a.components, b.components);
}

function compareKeys(a: readonly string[], b: readonly string[]): number {
  return compareCodePoints(a.join("\u0000"), b.join("\u0000"));
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
