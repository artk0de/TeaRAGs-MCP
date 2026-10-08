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
 * Both report paths rank through {@link rankByMaintenanceCost}: the whole-repo
 * `get_architecture_report` (carrying files from
 * {@link architectureViolationCarrierFiles}) and the diff-scoped
 * `review_changes` architecture section (its own carrier reading of a
 * `DiffDetectorFinding`). A new detector family adopts the score by routing
 * its list through the same ranker.
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

/** One file's cost before rounding — the ranking reads the unrounded value. */
interface FileMaintenanceCostReading {
  readonly exact: number;
  readonly dto: ArchitectureFileMaintenanceCost;
}

/**
 * Each measured file's cost, every signal positioned in the collection's own
 * distribution. Built once per report from one payload read.
 */
export class FileMaintenanceCostModel {
  private readonly commitCounts: readonly number[];
  private readonly bugFixRates: readonly number[];
  /** `-ageDays`, so the youngest file sits at the top like the other two. */
  private readonly youthScores: readonly number[];
  private readonly readings = new Map<RelPath, FileMaintenanceCostReading | null>();

  constructor(private readonly signals: ReadonlyMap<RelPath, GitFileMaintenanceSignals>) {
    const values = [...signals.values()];
    this.commitCounts = ascending(values.map((s) => s.commitCount));
    this.bugFixRates = ascending(values.map((s) => s.bugFixRate));
    this.youthScores = ascending(values.map((s) => -s.ageDays));
  }

  /** The file's cost and the signals behind it; undefined for a file the git trajectory never measured. */
  fileCost(relPath: RelPath): ArchitectureFileMaintenanceCost | undefined {
    return this.reading(relPath)?.dto;
  }

  /**
   * A violation's cost over the files carrying it: the mean over the measured
   * ones (size-neutral, so a component-level violation and a file pair compare
   * on one scale), and the costliest one named. Undefined when none is measured.
   */
  costOf(carriers: readonly RelPath[]): { exact: number; cost: ArchitectureMaintenanceCost } | undefined {
    const files = [...new Set(carriers)];
    let sum = 0;
    let measured = 0;
    let hottest: FileMaintenanceCostReading | undefined;
    for (const relPath of files) {
      const reading = this.reading(relPath);
      if (reading === undefined) continue;
      sum += reading.exact;
      measured++;
      if (hottest === undefined || reading.exact > hottest.exact) hottest = reading;
    }
    if (hottest === undefined) return undefined;
    const exact = sum / measured;
    return {
      exact,
      cost: { score: round3(exact), fileCount: files.length, measuredFileCount: measured, hottestFile: hottest.dto },
    };
  }

  private reading(relPath: RelPath): FileMaintenanceCostReading | undefined {
    const cached = this.readings.get(relPath);
    if (cached !== undefined) return cached ?? undefined;
    const signal = this.signals.get(relPath);
    if (signal === undefined) {
      this.readings.set(relPath, null);
      return undefined;
    }
    const churn = positionIn(this.commitCounts, signal.commitCount);
    const bugFix = positionIn(this.bugFixRates, signal.bugFixRate);
    const recency = positionIn(this.youthScores, -signal.ageDays);
    const exact = (churn * (1 + bugFix + recency)) / 3;
    const reading = {
      exact,
      dto: {
        relPath,
        cost: round3(exact),
        churn: round3(churn),
        bugFix: round3(bugFix),
        recency: round3(recency),
        commitCount: signal.commitCount,
        bugFixRate: signal.bugFixRate,
        ageDays: signal.ageDays,
      },
    };
    this.readings.set(relPath, reading);
    return reading;
  }
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
  if (model === undefined) return [...items];
  return items
    .map((item, index) => {
      const measured = model.costOf(carriersOf(item));
      return {
        index,
        exact: measured?.exact ?? -1,
        item: measured === undefined ? item : { ...item, maintenanceCost: measured.cost },
      };
    })
    .sort((a, b) => b.exact - a.exact || a.index - b.index)
    .map((ranked) => ranked.item);
}

/**
 * The fields a listed violation may name its carrying files by — the report
 * contract's vocabulary, read structurally so a new violation shape using the
 * same field names needs no case here.
 */
export interface ArchitectureViolationCarrierFields {
  sourceRelPath?: RelPath;
  targetRelPath?: RelPath;
  relPath?: RelPath;
  partners?: readonly { relPath: RelPath }[];
  component?: string;
  components?: readonly string[];
  sourceComponent?: string;
  targetComponent?: string;
  evidence?: {
    fileEdges?: readonly ArchitectureFileEdge[];
    feedbackArcSet?: readonly { fileEdges: readonly ArchitectureFileEdge[] }[];
  };
}

/**
 * The files carrying one violation: the files it names (endpoints, a shared
 * endpoint and its partners, the file edges behind a component edge or a
 * knot's feedback arcs); only when it names none, the files of the components
 * it names — the most specific carrier the violation states.
 */
export function architectureViolationCarrierFiles(
  listed: object,
  filesOfComponent: (component: string) => readonly RelPath[],
): RelPath[] {
  // Read structurally: every violation shape is an object, and the fields
  // below are optional on all of them — a shape without them names no file.
  const violation = listed as ArchitectureViolationCarrierFields;
  const files: RelPath[] = [];
  const push = (relPath: RelPath | undefined): void => {
    if (relPath !== undefined) files.push(relPath);
  };
  const pushEdges = (edges: readonly ArchitectureFileEdge[] | undefined): void => {
    for (const edge of edges ?? []) {
      files.push(edge.sourceRelPath, edge.targetRelPath);
    }
  };
  push(violation.sourceRelPath);
  push(violation.targetRelPath);
  push(violation.relPath);
  for (const partner of violation.partners ?? []) push(partner.relPath);
  pushEdges(violation.evidence?.fileEdges);
  for (const arc of violation.evidence?.feedbackArcSet ?? []) pushEdges(arc.fileEdges);
  if (files.length > 0) return [...new Set(files)];

  const components = [
    violation.component,
    violation.sourceComponent,
    violation.targetComponent,
    ...(violation.components ?? []),
  ].filter((c): c is string => c !== undefined);
  return [...new Set(components.flatMap((component) => filesOfComponent(component)))];
}

/** The inverse of a partition's `componentOf`: each component's files. */
export function filesByComponent(componentOf: ReadonlyMap<RelPath, string>): (component: string) => readonly RelPath[] {
  const index = new Map<string, RelPath[]>();
  for (const [relPath, component] of componentOf) {
    const files = index.get(component);
    if (files === undefined) index.set(component, [relPath]);
    else files.push(relPath);
  }
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

/** How many values are strictly below `value` (binary search over an ascending list). */
function countBelow(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function ascending(values: number[]): number[] {
  return values.sort((a, b) => a - b);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
