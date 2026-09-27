import type { FileDependencyGraphFile } from "../../../../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../../../../infra/path-pattern.js";
import { resolveMajorityFlooredOtsuThreshold } from "./otsu-split.js";
import { DEFAULT_SDP_MIN_CONNECTION_COUNT } from "./stable-dependencies.js";
import type {
  ComponentGraph,
  MainSequenceComponentVolatility,
  MainSequenceExclusionCounts,
  MainSequenceOptions,
  MainSequenceReport,
  MainSequenceScope,
  MainSequenceViolation,
  MainSequenceVolatilitySummary,
} from "./types.js";

/**
 * Fewest types A is read from. A moves in steps of 1/n: below 5 a single type
 * moves it by at least 0.2 — as much as the margin between the floor and a
 * clean component — so one declaration decides the verdict. Measured on the
 * self-index, 1 / 3 / 5 left 13 / 11 / 10 violations; the difference is
 * components of 3 or 4 types read as pure abstraction or pure concretion.
 */
export const DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT = 5;

/**
 * D a component must strictly exceed: past half-way from the main sequence to
 * the worst corner. The Otsu cut can only raise it — on the self-index Otsu
 * split judged distances at 0.398, below the floor, so the floor decides there.
 */
export const MAIN_SEQUENCE_DISTANCE_FLOOR = 0.5;

/** Human-readable meaning of the `unobservableAbstractness` exclusion. */
export const MAIN_SEQUENCE_UNOBSERVABLE_REASON =
  "unobservable abstractness: the component's languages declare abstractions so rarely in this codebase that one of its size would not be expected to show any - an A of 0 is the language's idiom, not the component's";

/** Same population floor the other boundary detectors trust Otsu's split on. */
export const MAIN_SEQUENCE_OTSU_MIN_POPULATION = 8;

/** Human-readable meaning of the `stableConcreteCalm` exclusion. */
export const MAIN_SEQUENCE_STABLE_CONCRETE_CALM_REASON =
  "stable and concrete but calm: its files change no more often than the volatility cut, so the rigidity costs nothing - the zone of pain hurts only a component that keeps changing";

interface ComponentCensus {
  abstractTypeCount: number;
  concreteTypeCount: number;
  measuredFileCount: number;
  fileCount: number;
  /** Σ types × the abstract share of the file's language — abstract types a component of this makeup would show. */
  expectedAbstractTypeCount: number;
  paths: string[];
}

/**
 * Stable Abstractions Principle (bd tea-rags-mcp-r8hme.8): per component,
 * A = abstract / (abstract + concrete) types over its files, I from the
 * component graph, D = |A + I - 1|. A component far from the main sequence is
 * in the zone of PAIN (stable and concrete, A + I < 1 — rigid, and every change
 * reaches its dependents) or of USELESSNESS (unstable and abstract — contracts
 * nobody depends on).
 *
 * A component is judged unless, in order:
 *
 * 1. its Ca + Ce is below `minConnectionCount` — the SDP floor, same argument;
 * 2. no file of it carries a census (`unmeasured` — an index written before
 *    the census existed; a codegraph recompute fills it);
 * 3. it holds fewer than `minTypeCount` types;
 * 4. its abstractness is UNOBSERVABLE: summing, over its files, the type count
 *    times its language's abstract share across the whole graph gives the
 *    abstract types a component of its makeup would show — below 1, an A of 0
 *    is that language's idiom here, not a trait of the component. Measured on
 *    taxdome, Ruby declares 34 abstract types of 12,457 (`raise
 *    NotImplementedError` is its only spelling of one; duck typing declares
 *    nothing), so without this every stable Rails directory read as the zone of
 *    pain — 221 of 221 violations. TypeScript there shares 51%, here 19%.
 *
 * Judged distances set an adaptive cut (Otsu, majority-floored at
 * `MAIN_SEQUENCE_DISTANCE_FLOOR`). `sourcePathPattern` only decides which
 * judged components are reported; shares, the cut and the mean are whole-graph.
 *
 * With `fileVolatility` (bd tea-rags-mcp-r8hme.14) the zone of pain is gated
 * on change: per Martin it hurts only a VOLATILE component — `String` is
 * stable, concrete and fine. A component's volatility is the mean reading over
 * its files that carry one; the cut is Otsu's split over the judged
 * components' log volatilities, floored at the median file's reading (a component
 * whose typical file changes no more than the codebase's typical file is not
 * volatile), and the floor alone below `MAIN_SEQUENCE_OTSU_MIN_POPULATION`.
 * A pain component past the distance cut but not volatile is counted as
 * `stableConcreteCalm` instead of reported; one with no reading at all is
 * reported, since nothing shows it calm. Uselessness is judged on D alone.
 */
export function detectMainSequenceDeviations(
  componentGraph: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
  options: MainSequenceOptions = {},
): MainSequenceReport {
  const minConnectionCount = options.minConnectionCount ?? DEFAULT_SDP_MIN_CONNECTION_COUNT;
  const minTypeCount = options.minTypeCount ?? DEFAULT_MAIN_SEQUENCE_MIN_TYPE_COUNT;
  const share = abstractShareByLanguage(files);
  const censuses = censusByComponent(componentGraph, files, share);
  const excluded: MainSequenceExclusionCounts = {
    lowConnectionCount: 0,
    unmeasured: 0,
    fewTypes: 0,
    unobservableAbstractness: 0,
    stableConcreteCalm: 0,
  };

  const judged: { violation: MainSequenceViolation; paths: string[] }[] = [];
  for (const component of componentGraph.components.values()) {
    const census = censuses.get(component.componentDir);
    const typeCount = census ? census.abstractTypeCount + census.concreteTypeCount : 0;
    if (component.connectionCount < minConnectionCount) excluded.lowConnectionCount++;
    else if (!census || census.measuredFileCount === 0) excluded.unmeasured++;
    else if (typeCount < minTypeCount) excluded.fewTypes++;
    else if (census.expectedAbstractTypeCount < 1) excluded.unobservableAbstractness++;
    else {
      const abstractness = census.abstractTypeCount / typeCount;
      const { instability } = component;
      judged.push({
        paths: census.paths,
        violation: {
          component: component.componentDir,
          kind: component.kind,
          facadeRelPath: component.facadeRelPath,
          zone: abstractness + instability < 1 ? "pain" : "uselessness",
          distance: Math.abs(abstractness + instability - 1),
          abstractness,
          instability,
          abstractTypeCount: census.abstractTypeCount,
          concreteTypeCount: census.concreteTypeCount,
          afferentCount: component.afferentCount,
          efferentCount: component.efferentCount,
          fileCount: census.fileCount,
          unmeasuredFileCount: census.fileCount - census.measuredFileCount,
        },
      });
    }
  }

  const distances = judged.map((j) => j.violation.distance);
  const threshold = resolveMajorityFlooredOtsuThreshold(distances, {
    majority: MAIN_SEQUENCE_DISTANCE_FLOOR,
    minPopulation: MAIN_SEQUENCE_OTSU_MIN_POPULATION,
  });
  const inScope = compilePathPatternMatcher(options.sourcePathPattern);
  const scope: MainSequenceScope | undefined =
    inScope && options.sourcePathPattern
      ? { sourcePathPattern: options.sourcePathPattern, outOfScopeComponentCount: 0 }
      : undefined;

  const volatilityGate = resolveVolatilityGate(judged, files, options.fileVolatility);

  const violations: MainSequenceViolation[] = [];
  for (const { violation, paths } of judged) {
    if (scope && inScope && !paths.some(inScope)) {
      scope.outOfScopeComponentCount++;
      continue;
    }
    if (!threshold.admits(violation.distance)) continue;
    const volatility = volatilityGate?.judge(paths);
    if (violation.zone === "pain" && volatility?.label === "calm") {
      excluded.stableConcreteCalm++;
      continue;
    }
    violations.push(volatility ? { ...violation, volatility } : violation);
  }
  violations.sort((a, b) => b.distance - a.distance || compareCodePoints(a.component, b.component));

  return {
    violations,
    summary: {
      componentCount: componentGraph.components.size,
      judgedComponentCount: judged.length,
      violationCount: violations.length,
      painCount: violations.filter((v) => v.zone === "pain").length,
      uselessnessCount: violations.filter((v) => v.zone === "uselessness").length,
      meanDistance: distances.length > 0 ? distances.reduce((s, d) => s + d, 0) / distances.length : 0,
      distanceThreshold: threshold.threshold,
      distanceThresholdMethod: threshold.method,
      ...(threshold.separability !== undefined ? { distanceSeparability: threshold.separability } : {}),
      minConnectionCount,
      minTypeCount,
      abstractTypeShareByLanguage: Object.fromEntries(share),
      excluded,
      ...(volatilityGate ? { volatility: volatilityGate.summary } : {}),
      ...(scope ? { scope } : {}),
    },
  };
}

interface MainSequenceVolatilityGate {
  summary: MainSequenceVolatilitySummary;
  /** The component's volatility and label; undefined when none of its files has a reading. */
  judge: (paths: readonly string[]) => MainSequenceComponentVolatility | undefined;
}

/**
 * The volatility cut, drawn from the data it judges: undefined when no graph
 * file has a reading — the gate then does not run and pain stays judged on D.
 */
function resolveVolatilityGate(
  judged: readonly { paths: string[] }[],
  files: readonly FileDependencyGraphFile[],
  fileVolatility: ReadonlyMap<string, number> | undefined,
): MainSequenceVolatilityGate | undefined {
  if (!fileVolatility || fileVolatility.size === 0) return undefined;
  const readings = files.flatMap((f) => {
    const reading = fileVolatility.get(f.relPath);
    return reading === undefined ? [] : [reading];
  });
  if (readings.length === 0) return undefined;
  const fileMedian = median(readings);

  const meanOf = (paths: readonly string[]) => {
    let sum = 0;
    let measuredFileCount = 0;
    for (const relPath of paths) {
      const reading = fileVolatility.get(relPath);
      if (reading === undefined) continue;
      sum += reading;
      measuredFileCount++;
    }
    return measuredFileCount > 0 ? { value: sum / measuredFileCount, measuredFileCount } : undefined;
  };
  const population = judged.flatMap(({ paths }) => {
    const mean = meanOf(paths);
    return mean ? [mean.value] : [];
  });
  // Split on the LOG scale: change counts spread multiplicatively (on the
  // self-index the median file has 3 commits and p95 16), and on the raw scale
  // the few hottest components carry most of the variance, so Otsu isolates
  // them and reads everything merely active as calm — measured 10.9 against 6.1
  // there. A mean of 0 maps to -Infinity: below every cut, calm by any reading.
  const cut = resolveMajorityFlooredOtsuThreshold(population.map(Math.log), {
    majority: Math.log(fileMedian),
    minPopulation: MAIN_SEQUENCE_OTSU_MIN_POPULATION,
  });
  const threshold = cut.method === "otsu" ? Math.exp(cut.threshold) : fileMedian;

  return {
    summary: {
      threshold,
      thresholdMethod: cut.method === "otsu" ? "otsu" : "fileMedian",
      ...(cut.separability !== undefined ? { separability: cut.separability } : {}),
      fileMedian,
      measuredComponentCount: population.length,
    },
    judge: (paths) => {
      const mean = meanOf(paths);
      if (!mean) return undefined;
      return { ...mean, threshold, label: cut.admits(Math.log(mean.value)) ? "volatile" : "calm" };
    },
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Abstract types over all measured types, per language, across the whole graph. */
function abstractShareByLanguage(files: readonly FileDependencyGraphFile[]): Map<string, number> {
  const totals = new Map<string, { abstract: number; all: number }>();
  for (const file of files) {
    const census = file.typeAbstractness;
    if (!census) continue;
    const total = totals.get(file.language) ?? { abstract: 0, all: 0 };
    total.abstract += census.abstractTypeCount;
    total.all += census.abstractTypeCount + census.concreteTypeCount;
    totals.set(file.language, total);
  }
  const share = new Map<string, number>();
  for (const [language, { abstract, all }] of [...totals].sort(([a], [b]) => compareCodePoints(a, b))) {
    share.set(language, all > 0 ? abstract / all : 0);
  }
  return share;
}

function censusByComponent(
  componentGraph: ComponentGraph,
  files: readonly FileDependencyGraphFile[],
  share: ReadonlyMap<string, number>,
): Map<string, ComponentCensus> {
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const out = new Map<string, ComponentCensus>();
  for (const [relPath, componentDir] of componentGraph.componentOf) {
    const census = out.get(componentDir) ?? {
      abstractTypeCount: 0,
      concreteTypeCount: 0,
      measuredFileCount: 0,
      fileCount: 0,
      expectedAbstractTypeCount: 0,
      paths: [],
    };
    census.fileCount++;
    census.paths.push(relPath);
    const file = byPath.get(relPath);
    const fileCensus = file?.typeAbstractness;
    if (file && fileCensus) {
      census.measuredFileCount++;
      census.abstractTypeCount += fileCensus.abstractTypeCount;
      census.concreteTypeCount += fileCensus.concreteTypeCount;
      census.expectedAbstractTypeCount +=
        (fileCensus.abstractTypeCount + fileCensus.concreteTypeCount) * (share.get(file.language) ?? 0);
    }
    out.set(componentDir, census);
  }
  return out;
}

/** Locale-independent, so the order is the same on every machine. */
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
