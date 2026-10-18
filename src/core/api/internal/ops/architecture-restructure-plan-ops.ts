/**
 * ArchitectureRestructurePlanOps — `get_architecture_report` restructurePlan
 * mode (bd tea-rags-mcp-cm9gt.2): an ORDERED refactoring plan over candidate
 * hypotheses, simulated before anyone edits a file.
 *
 * A restructure delta is joint — step 2's value depends on step 1 having
 * happened — so ranking remedies one call each cannot order a sequence. The
 * plan is greedy over the same judge restructure mode uses: the graph facts
 * are read ONCE, every round compiles `prefix ++ candidate` against the base
 * partition and judges it uncapped, the delta is taken against the prefix's
 * own run, and the best candidate is appended by a lexicographic vector —
 * net resolved critical, then active, then structural (an untiered violation
 * counts as structural) — ties by the smaller blast radius (Σ codegraph
 * transitiveImpact of the files the ops name or relabel — a merge touches every
 * file of the components it folds), then by id. No weights, no
 * constants, no step cap: the loop stops when the best vector is not
 * positive.
 *
 * A candidate introducing a critical or active violation is a trade-off:
 * reported, never selected, out of the pool. A candidate whose ops no longer
 * compile on the prefix (its edge already removed, its file already moved)
 * conflicts with the prefix and leaves the pool; a caller candidate that does
 * not compile against the base is an input bug and throws - against the
 * partition every caller addFile is pre-registered into (bd
 * tea-rags-mcp-54xwd.22), so a candidate referencing a sibling's new file is
 * judged, not rejected. Every violation is kept on BASE paths
 * (`withCanonicalPaths`), so consecutive prefixes compare by key however many
 * moves they hold.
 */

import type { ArchitectureRestructureCompiledOp } from "../../../contracts/types/architecture-report.js";
import type { RelPath } from "../../../contracts/types/codegraph.js";
import {
  applyArchitectureRestructure,
  compileArchitectureRestructure,
  type ArchitectureRestructureCompilation,
  type ArchitectureRestructureEdgeBase,
  type ArchitectureRestructurePartition,
  type ArchitectureRestructureRelabel,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  ARCHITECTURE_RESTRUCTURE_OP_LIMIT,
  ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT,
  type ArchitectureRestructureOp,
  type ArchitectureRestructurePlanCandidate,
  type ArchitectureRestructurePlanCandidateSource,
  type ArchitectureRestructurePlanDelta,
  type ArchitectureRestructurePlanStep,
  type ArchitectureRestructurePlanTradeOff,
  type ArchitectureRestructurePlanUnselected,
  type ArchitectureRestructureTierTally,
  type ArchitectureViolation,
  type ArchitectureViolationImpactTier,
  type GetArchitectureReportRequest,
  type GetArchitectureReportResponse,
  type GetArchitectureRestructurePlanResponse,
} from "../../public/dto/architecture.js";
import { InvalidParameterError } from "../../public/errors.js";
import { readArchitectureGraphFacts, type ArchitectureReportGraphDb } from "./architecture-graph-facts.js";
import { ArchitectureReportOps, readOnce } from "./architecture-report-ops.js";
import { compareCodePoints } from "./architecture-report/index.js";
import {
  DEFAULT_SUBJECT_LIMIT,
  deriveArchitectureRestructureBase,
  relabelledSignals,
  REPORT_ONLY_OPTIONS,
  restructureDelta,
  throwArchitectureRestructureCompileFailure,
  type ArchitectureRestructureLookups,
  type FileTransitiveImpactLookup,
} from "./architecture-restructure-ops.js";
import {
  measureArchitectureViolationDelta,
  resolvedChangeSubjects,
  violationChangeSubject,
  withCanonicalPaths,
  type ArchitectureViolationDelta,
} from "./architecture-violation-delta.js";

/** The report-derived candidates own this id prefix; caller ids may not use it. */
const REPORT_CANDIDATE_ID_PREFIX = "report:";

/** Objective order: the first tier outranks every count of the next. */
const PLAN_TIERS: readonly ArchitectureViolationImpactTier[] = ["critical", "active", "structural"];

const UNCAPPED = { limit: Number.POSITIVE_INFINITY };

/** One pool entry: a caller or report hypothesis, with the blast radius of the files it names. */
interface PlanPoolCandidate extends ArchitectureRestructurePlanCandidate {
  source: ArchitectureRestructurePlanCandidateSource;
  touchedFiles: RelPath[];
  blastRadius: number;
}

/** A prefix's judged violations, on base paths, and the ops that produced it. */
interface PlanPrefix {
  ops: ArchitectureRestructureOp[];
  violations: readonly ArchitectureViolation[];
}

/** A candidate judged on the current prefix and admitted to the round's pick. */
interface JudgedPlanCandidate {
  candidate: PlanPoolCandidate;
  /** The candidate's ops in compiled form - prelude addFiles spliced back in. */
  ops: ArchitectureRestructurePlanStep["ops"];
  violations: readonly ArchitectureViolation[];
  delta: ArchitectureRestructurePlanDelta;
  /** Net resolved per tier, in {@link PLAN_TIERS} order. */
  vector: number[];
}

export class ArchitectureRestructurePlanOps {
  constructor(private readonly report: Pick<ArchitectureReportOps, "judge"> = new ArchitectureReportOps()) {}

  async plan(
    graphDb: ArchitectureReportGraphDb,
    request: GetArchitectureReportRequest,
    lookups: ArchitectureRestructureLookups = {},
  ): Promise<GetArchitectureRestructurePlanResponse> {
    const startedAt = performance.now();
    const { candidates, includeReportCandidates } = validateRestructurePlanRequest(request);
    const facts = await readArchitectureGraphFacts(
      graphDb,
      {},
      lookups.readIndexedFileImports,
      lookups.readDeclaredTestDependencies,
      lookups.readTreeFileText,
    );
    const factsMs = Math.round(performance.now() - startedAt);
    const { partition: basePartition, edgeBase } = deriveArchitectureRestructureBase(facts);
    // bd tea-rags-mcp-54xwd.22: candidates may share a file a sibling's addFile
    // creates - the hubLike recipe's extracted-interface pattern is one
    // candidate per consumer cluster, all of them importing the same new
    // interface file. Every caller addFile is pre-registered into the
    // partition before anything compiles, so a cross-candidate reference is
    // judged like any other hypothesis; each candidate's own addFile ops drop
    // out of compilation (the prelude holds the file) and stay in the
    // reported ops.
    const { partition, compiledAddFileOf } = preludeCallerAddFiles(candidates, basePartition, edgeBase);
    // An addFile the prelude registered compiles to nothing - the file is
    // already in the partition; its compiled form splices back into the
    // step's displayed ops.
    const dropsPreludeAddFile = (op: ArchitectureRestructureOp): boolean =>
      "addFile" in op && compiledAddFileOf.has(op.addFile.file);
    const compileOps = (ops: readonly ArchitectureRestructureOp[]) =>
      compileArchitectureRestructure(
        ops.filter((op) => !dropsPreludeAddFile(op)),
        partition,
        edgeBase,
      );
    /** The candidate's ops as compiled ops: the filtered compile's forms, with the prelude's addFile forms spliced in. */
    const displayOpsOf = (
      ops: readonly ArchitectureRestructureOp[],
      compiled: readonly ArchitectureRestructureCompiledOp[],
    ): ArchitectureRestructureCompiledOp[] => {
      const queue = [...compiled];
      const compiledOps: ArchitectureRestructureCompiledOp[] = [];
      for (const op of ops) {
        if ("addFile" in op) {
          const registered = compiledAddFileOf.get(op.addFile.file);
          if (registered !== undefined) {
            compiledOps.push(registered);
            continue;
          }
        }
        const next = queue.shift();
        if (next !== undefined) compiledOps.push(next);
      }
      return compiledOps;
    };
    for (const candidate of candidates) {
      const compilation = compileOps(candidate.ops);
      if (compilation.kind !== "compiled") throwArchitectureRestructureCompileFailure(compilation);
    }
    const baseSignals = lookups.readFileMaintenanceSignals && readOnce(lookups.readFileMaintenanceSignals);
    let judgeCount = 0;
    const judgeOps = async (ops: readonly ArchitectureRestructureOp[]) => {
      const compilation = compileOps(ops);
      if (compilation.kind !== "compiled") return compilation;
      judgeCount++;
      const run = await this.report.judge(applyArchitectureRestructure(facts, compilation.relabel), UNCAPPED, {
        readFileMaintenanceSignals: baseSignals && relabelledSignals(baseSignals, compilation.relabel),
      });
      const { renamedFrom } = compilation.relabel;
      return { compilation, violations: run.violations.map((violation) => withCanonicalPaths(violation, renamedFrom)) };
    };

    judgeCount++;
    const base = await this.report.judge(facts, UNCAPPED, { readFileMaintenanceSignals: baseSignals });
    const pool = await planPool(
      [
        ...candidates.map((candidate) => ({ ...candidate, source: "caller" as const })),
        ...(includeReportCandidates ? reportPlanCandidates(base) : []),
      ],
      compileOps,
      lookups.readFileTransitiveImpacts,
    );
    const limit = request.limit ?? DEFAULT_SUBJECT_LIMIT;
    const steps: ArchitectureRestructurePlanStep[] = [];
    const tradeOffs: ArchitectureRestructurePlanTradeOff[] = [];
    const unselected: ArchitectureRestructurePlanUnselected[] = [];
    let prefix: PlanPrefix = { ops: [], violations: base.violations };
    let remaining = pool;
    while (remaining.length > 0) {
      const judgedCandidates: JudgedPlanCandidate[] = [];
      for (const candidate of remaining) {
        const answer = await judgeOps([...prefix.ops, ...candidate.ops]);
        if ("kind" in answer) {
          unselected.push({
            ...candidateHandle(candidate),
            reason: "conflictsWithPrefix",
            detail: restructureCompileFailureDetail(answer),
          });
          continue;
        }
        const delta = planDelta(measureArchitectureViolationDelta(prefix.violations, answer.violations), limit);
        if (delta.byTier.critical.introduced > 0 || delta.byTier.active.introduced > 0) {
          tradeOffs.push({ ...candidateHandle(candidate), ...rationaleOf(candidate), delta });
          continue;
        }
        judgedCandidates.push({
          candidate,
          ops: displayOpsOf(candidate.ops, answer.compilation.ops),
          violations: answer.violations,
          delta,
          vector: PLAN_TIERS.map((tier) => delta.byTier[tier].resolved - delta.byTier[tier].introduced),
        });
      }
      const [pick, ...rest] = judgedCandidates.sort(compareJudgedPlanCandidates);
      if (pick === undefined || !isPlanImprovement(pick.vector)) {
        for (const { candidate } of judgedCandidates) {
          unselected.push({ ...candidateHandle(candidate), reason: "noImprovement" });
        }
        break;
      }
      steps.push(planStep(pick));
      prefix = { ops: [...prefix.ops, ...pick.candidate.ops], violations: pick.violations };
      remaining = rest.map(({ candidate }) => candidate).sort(compareById);
    }
    return {
      mode: "restructurePlan",
      steps,
      tradeOffs,
      unselected,
      total: planDelta(measureArchitectureViolationDelta(base.violations, prefix.violations), limit),
      timing: { factsMs, judgeCount, totalMs: Math.round(performance.now() - startedAt) },
    };
  }

  /** The mode's answer when no codegraph can be read: nothing judged, nothing planned. */
  static unavailable(request: GetArchitectureReportRequest): GetArchitectureRestructurePlanResponse {
    validateRestructurePlanRequest(request);
    return {
      mode: "restructurePlan",
      steps: [],
      tradeOffs: [],
      unselected: [],
      total: planDelta({ introduced: new Map(), resolved: new Map(), persisting: new Set() }, 0),
      timing: { factsMs: 0, judgeCount: 0, totalMs: 0 },
      unavailable: "noCodegraph",
    };
  }
}

function validateRestructurePlanRequest(request: GetArchitectureReportRequest): {
  candidates: ArchitectureRestructurePlanCandidate[];
  includeReportCandidates: boolean;
} {
  const plan = request.restructurePlan;
  if (plan === undefined) throw new InvalidParameterError("restructurePlan", "name the candidates to order");
  const riding = [...REPORT_ONLY_OPTIONS, "restructure" as const].filter((option) => request[option] !== undefined);
  if (riding.length > 0) {
    throw new InvalidParameterError(
      "restructurePlan",
      `restructurePlan mode answers an ordered plan, not a report or one hypothesis; drop ${riding.join(", ")}`,
    );
  }
  const includeReportCandidates = plan.includeReportCandidates !== false;
  const { candidates } = plan;
  if (candidates.length === 0 && !includeReportCandidates) {
    throw new InvalidParameterError(
      "restructurePlan",
      "name at least one candidate or include the report's candidates",
    );
  }
  if (candidates.length > ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT) {
    throw new InvalidParameterError(
      "restructurePlan",
      `at most ${ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT} candidates per call, got ${candidates.length}`,
    );
  }
  const ids = new Set<string>();
  for (const { id, ops } of candidates) {
    if (id.length === 0 || id.startsWith(REPORT_CANDIDATE_ID_PREFIX)) {
      throw new InvalidParameterError(
        "restructurePlan",
        `candidate id "${id}" must be non-empty and not start with "${REPORT_CANDIDATE_ID_PREFIX}"`,
      );
    }
    if (ids.has(id)) throw new InvalidParameterError("restructurePlan", `candidate id "${id}" is not unique`);
    ids.add(id);
    if (ops.length === 0 || ops.length > ARCHITECTURE_RESTRUCTURE_OP_LIMIT) {
      throw new InvalidParameterError(
        "restructurePlan",
        `candidate "${id}" needs 1..${ARCHITECTURE_RESTRUCTURE_OP_LIMIT} ops, got ${ops.length}`,
      );
    }
  }
  return { candidates, includeReportCandidates };
}

/**
 * One candidate per split / merge verdict of the judged base, in report order.
 * Layer-map move candidates are not built: the base judge has no layer-map scope.
 */
function reportPlanCandidates(
  baseReport: GetArchitectureReportResponse,
): (ArchitectureRestructurePlanCandidate & { source: "report" })[] {
  const { verdicts } = baseReport.summary.splitMerge;
  if (verdicts === undefined) return [];
  return [
    ...verdicts.splitCandidates.map((split, k) => ({
      id: `${REPORT_CANDIDATE_ID_PREFIX}split:${k + 1}`,
      source: "report" as const,
      ops: [{ split: { component: split.component, groups: split.files.map((group) => [...group]) } }],
    })),
    ...verdicts.mergeCandidates.map((merge, k) => ({
      id: `${REPORT_CANDIDATE_ID_PREFIX}merge:${k + 1}`,
      source: "report" as const,
      ops: [{ merge: { components: [merge.componentA, merge.componentB] } }],
    })),
  ];
}

/** The pool in id order, each candidate with its touched files and their summed transitive impact (one read). */
async function planPool(
  candidates: readonly (ArchitectureRestructurePlanCandidate & {
    source: ArchitectureRestructurePlanCandidateSource;
  })[],
  compileOnBase: (ops: readonly ArchitectureRestructureOp[]) => ArchitectureRestructureCompilation,
  readFileTransitiveImpacts: FileTransitiveImpactLookup | undefined,
): Promise<PlanPoolCandidate[]> {
  const touched = candidates.map((candidate) => {
    const compilation = compileOnBase(candidate.ops);
    return touchedFilesOf(candidate.ops, compilation.kind === "compiled" ? compilation.relabel : undefined);
  });
  const impacts = readFileTransitiveImpacts
    ? await readFileTransitiveImpacts([...new Set(touched.flat())].sort(compareCodePoints))
    : new Map<RelPath, number>();
  return candidates
    .map((candidate, k) => {
      const touchedFiles = touched[k] ?? [];
      const blastRadius = touchedFiles.reduce((sum, relPath) => sum + (impacts.get(relPath) ?? 0), 0);
      return { ...candidate, touchedFiles, blastRadius };
    })
    .sort(compareById);
}

/**
 * The base paths the ops name plus every base file the base-compiled relabel
 * relabels, code-point sorted: a merge names components, not files, and still
 * moves every file of the components it folds.
 */
function touchedFilesOf(
  ops: readonly ArchitectureRestructureOp[],
  relabel: ArchitectureRestructureRelabel | undefined,
): RelPath[] {
  const files = new Set<RelPath>();
  for (const relPath of relabel?.componentOf.keys() ?? []) files.add(relabel?.renamedFrom.get(relPath) ?? relPath);
  for (const op of ops) {
    if ("move" in op) op.move.files.forEach((relPath) => files.add(relPath));
    else if ("split" in op) op.split.groups.flat().forEach((relPath) => files.add(relPath));
    else if ("addFile" in op) files.add(op.addFile.file);
    else if ("addEdge" in op) files.add(op.addEdge.from).add(op.addEdge.to);
    else if ("removeEdge" in op) files.add(op.removeEdge.from).add(op.removeEdge.to);
  }
  return [...files].sort(compareCodePoints);
}

/** A delta's compact form plus its per-tier tally: introduced tiers from the later run, resolved from the earlier. */
function planDelta(delta: ArchitectureViolationDelta, limit: number): ArchitectureRestructurePlanDelta {
  const introduced = [...delta.introduced].map(([key, violation]) => violationChangeSubject(key, violation));
  const byTier = Object.fromEntries(
    PLAN_TIERS.map((tier) => [tier, { resolved: 0, introduced: 0 }]),
  ) as ArchitectureRestructureTierTally;
  for (const violation of delta.introduced.values()) byTier[violation.tier ?? "structural"].introduced++;
  for (const violation of delta.resolved.values()) byTier[violation.tier ?? "structural"].resolved++;
  return {
    ...restructureDelta(introduced, resolvedChangeSubjects(delta), delta.persisting.size, limit),
    byTier,
  };
}

/** Better first: larger net per tier in order, then the smaller blast radius, then id. */
function compareJudgedPlanCandidates(a: JudgedPlanCandidate, b: JudgedPlanCandidate): number {
  for (const [k, net] of a.vector.entries()) {
    const other = b.vector[k] ?? 0;
    if (net !== other) return other - net;
  }
  if (a.candidate.blastRadius !== b.candidate.blastRadius) return a.candidate.blastRadius - b.candidate.blastRadius;
  return compareCodePoints(a.candidate.id, b.candidate.id);
}

/** Lexicographically positive: the first non-zero entry gains. */
function isPlanImprovement(vector: readonly number[]): boolean {
  const first = vector.find((net) => net !== 0);
  return first !== undefined && first > 0;
}

function compareById(a: { id: string }, b: { id: string }): number {
  return compareCodePoints(a.id, b.id);
}

function candidateHandle(candidate: PlanPoolCandidate) {
  return { candidateId: candidate.id, source: candidate.source };
}

function rationaleOf(candidate: PlanPoolCandidate): { rationale?: string } {
  return candidate.rationale === undefined ? {} : { rationale: candidate.rationale };
}

function planStep(pick: JudgedPlanCandidate): ArchitectureRestructurePlanStep {
  const { candidate } = pick;
  return {
    ...candidateHandle(candidate),
    ...rationaleOf(candidate),
    ops: pick.ops,
    delta: pick.delta,
    touchedFiles: candidate.touchedFiles,
    blastRadius: candidate.blastRadius,
  };
}

/**
 * The partition every candidate compiles against: the base plus every caller
 * addFile that names a component (bd tea-rags-mcp-54xwd.22) - candidates
 * share files a sibling's addFile creates, so the file must be known before
 * the first op compiles. Two candidates adding the same file into different
 * components is an input conflict; an addFile the graph already holds is one
 * too. A component-less addFile cannot enter the partition and keeps the
 * base-only compile semantics. Returns each registered file's compiled addFile
 * op, so a step's displayed ops keep the form the caller asked for.
 */
function preludeCallerAddFiles(
  candidates: readonly ArchitectureRestructurePlanCandidate[],
  partition: ArchitectureRestructurePartition,
  edgeBase: ArchitectureRestructureEdgeBase,
): {
  partition: ArchitectureRestructurePartition;
  compiledAddFileOf: ReadonlyMap<RelPath, ArchitectureRestructureCompiledOp>;
} {
  const componentOf = new Map<RelPath, string>();
  const order: ArchitectureRestructureOp[] = [];
  for (const { id, ops } of candidates) {
    for (const op of ops) {
      if (!("addFile" in op) || op.addFile.component === undefined) continue;
      const { file, component } = op.addFile;
      const claimed = componentOf.get(file);
      if (claimed !== undefined && claimed !== component) {
        throw new InvalidParameterError(
          "restructurePlan",
          `candidates add "${file}" into different components: "${claimed}" and "${component}" (${id})`,
        );
      }
      if (claimed === undefined) {
        if (partition.componentOf.has(file)) {
          throw new InvalidParameterError(
            "restructurePlan",
            `candidate "${id}" adds "${file}", which the production graph already holds`,
          );
        }
        componentOf.set(file, component);
        order.push(op);
      }
    }
  }
  const compilation = compileArchitectureRestructure(order, partition, edgeBase);
  if (compilation.kind !== "compiled") throwArchitectureRestructureCompileFailure(compilation);
  const compiledAddFileOf = new Map<RelPath, ArchitectureRestructureCompiledOp>();
  for (const compiled of compilation.ops) {
    if (compiled.op === "addFile" && compiled.file !== undefined) compiledAddFileOf.set(compiled.file, compiled);
  }
  return { partition: { componentOf: new Map([...partition.componentOf, ...componentOf]) }, compiledAddFileOf };
}

/** The message the typed compile error carries — a conflict is reported, not thrown. */
function restructureCompileFailureDetail(
  compilation: Exclude<ArchitectureRestructureCompilation, { kind: "compiled" }>,
): string {
  try {
    throwArchitectureRestructureCompileFailure(compilation);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
