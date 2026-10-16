/**
 * The caller-parameter pass (bd tea-rags-mcp-2m83f.44): before pass-2 writes a
 * single edge, observe every walked call site whose callee is one exact static
 * edge, type its arguments, bind them to the callee's parameters and fold the
 * callers into parameter types. A typed parameter can type the arguments its
 * method forwards, so the files declaring a callee whose typed parameters moved
 * are observed again — at most {@link CALLER_PARAM_MAX_ROUNDS} rounds, in
 * relPath order. Pass-2 then seeds the folded types like any parameter type and
 * resolves once, so no edge or counter is written twice.
 *
 * Runs inside `GraphBuildFinalizer#resolveAndUpsert`, so an ingest run and a
 * working-tree build share it. A caller the run did not walk is not observed;
 * its persisted observations stand in for it (bd tea-rags-mcp-2m83f.49).
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type {
  FileExtraction,
  GlobalSymbolTable,
  PersistedCallerArgObservation,
  RelPath,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { isDebug } from "../../../../primitives/diagnostics/index.js";
import {
  agreedCallerParamTypes,
  bindCallArgsToParams,
  CALLER_PARAM_MAX_ROUNDS,
  changedCallerParamTargets,
  foldCallerParamTypes,
  type CalleeParamShape,
  type CallerArgObservation,
  type CallerParamTypes,
} from "./caller-param-types.js";
import type { CallEdgeResolutionRunner } from "./resolution-runner.js";
import type { CodegraphRunState } from "./run-state.js";
import { indexSpillLines, SpillLineReader, type SpillLineSpan } from "./spill-line-index.js";

/** The runner surface the pass reads. */
export type CallerArgObserver = Pick<CallEdgeResolutionRunner, "observeCallerArgs">;

/** The definition `symbolId` names, or `undefined`. */
function definitionOf(symbolTable: GlobalSymbolTable, symbolId: string): SymbolDefinition | undefined {
  const direct = symbolTable.lookup(symbolId).find((def) => def.symbolId === symbolId);
  if (direct !== undefined) return direct;
  const member = symbolId.slice(Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf(".")) + 1);
  return symbolTable.lookupByShortName(member).find((def) => def.symbolId === symbolId);
}

/** The callee's parameter shape: positional names from the run's param index, capacity and keywords from its definition. */
function calleeShapeOf(
  runState: CodegraphRunState,
  symbolTable: GlobalSymbolTable,
  symbolId: string,
): CalleeParamShape | undefined {
  const def = definitionOf(symbolTable, symbolId);
  if (def === undefined) return undefined;
  const { arity, kwargs } = def;
  return {
    positional: runState.paramNames[symbolId] ?? [],
    ...(arity === undefined ? {} : { maxPositional: arity.maxPositional, hasRestPositional: arity.hasSplat }),
    keywords: kwargs === undefined ? [] : [...kwargs.required, ...(kwargs.optional ?? [])],
    ...(kwargs?.hasSplat === true ? { hasKeywordRest: true } : {}),
  };
}

/**
 * What the pass reads beyond the spill (bd tea-rags-mcp-2m83f.49): the
 * persisted observations of the run's languages, and a way to add an unwalked
 * callee's file to the spill. Both absent → the spill is the whole world, as
 * before persistence.
 */
export interface CallerParamPassScope {
  /** Every persisted observation of the run's languages, in (file, site) order. */
  readonly persisted?: readonly PersistedCallerArgObservation[];
  /**
   * Append these unwalked files to the spill for pass-2 and the next round;
   * answers the paths actually appended (a file gone since it was indexed is not).
   */
  readonly appendToSpill?: (relPaths: readonly RelPath[]) => Promise<readonly RelPath[]>;
}

/**
 * Run the pass and leave its product on `runState` (`callerParamTypes`,
 * `callerParamEvidence`, `stats.callerParamTyping`). Answers the fresh
 * observations of every spilled file, for pass-2 to persist with its edges.
 *
 * The fold reads every caller of the run's languages: the persisted
 * observations of the files the run did not walk, the fresh ones of the files
 * it did. A callee whose agreed parameter types differ from what the persisted
 * observations alone agree on — the types its persisted edges were resolved
 * with — is re-resolved: its file joins the spill, like a hierarchy dependent.
 * That is what keeps an incremental run's edges equal to a full run's.
 */
export async function runCallerParamPass(
  spillPath: string,
  observer: CallerArgObserver,
  runState: CodegraphRunState,
  symbolTable: GlobalSymbolTable,
  scope: CallerParamPassScope = {},
): Promise<ReadonlyMap<RelPath, readonly CallerArgObservation[]>> {
  let spansOf = await spansByFile(spillPath);
  const shapes = new Map<string, CalleeParamShape | undefined>();
  const shapeOf = (symbolId: string): CalleeParamShape | undefined => {
    if (!shapes.has(symbolId)) shapes.set(symbolId, calleeShapeOf(runState, symbolTable, symbolId));
    return shapes.get(symbolId);
  };
  const persisted = groupBySourceFile(scope.persisted ?? []);
  const persistedAgreed = foldObservations(runState, persisted, shapeOf).agreed;
  // Unwalked files keep their persisted observations; a spilled file's are replaced by fresh ones.
  const observations = new Map<string, readonly CallerArgObservation[]>(
    [...persisted].filter(([relPath]) => !spansOf.has(relPath)),
  );
  const fresh = new Map<RelPath, CallerArgObservation[]>();
  const stats = runState.stats.callerParamTyping;
  let reader = await SpillLineReader.open(spillPath);
  const observe = async (relPaths: readonly string[]): Promise<void> => {
    for (const relPath of relPaths) {
      const observed: CallerArgObservation[] = [];
      for (const span of spansOf.get(relPath) ?? []) {
        const extraction = parseQuietly(await reader.read(span));
        if (extraction !== undefined) observed.push(...observer.observeCallerArgs(extraction, symbolTable));
      }
      fresh.set(relPath, observed);
      if (observed.length > 0) observations.set(relPath, observed);
      else observations.delete(relPath);
    }
  };
  try {
    let pending = [...spansOf.keys()].sort();
    for (let round = 1; round <= CALLER_PARAM_MAX_ROUNDS && pending.length > 0; round++) {
      await observe(pending);
      stats.rounds = round;
      const before = runState.callerParamTypes;
      applyFold(runState, foldObservations(runState, observations, shapeOf));
      const reobserved = filesDeclaring(
        changedCallerParamTargets(before, runState.callerParamTypes),
        symbolTable,
        (p) => spansOf.has(p),
      );
      const appended = await appendDependents(
        filesDeclaring(
          changedCallerParamTargets(persistedAgreed, runState.callerParamTypes),
          symbolTable,
          (p) => !spansOf.has(p),
        ),
        scope,
      );
      if (appended.length > 0) {
        await reader.close();
        spansOf = await spansByFile(spillPath);
        reader = await SpillLineReader.open(spillPath);
      }
      pending = [...new Set([...reobserved, ...appended])].sort();
    }
    // A file appended in the last round is resolved by pass-2 but was never observed: observe it once so
    // its persisted observations stay current, and fold it in.
    const unobserved = [...spansOf.keys()].filter((relPath) => !fresh.has(relPath)).sort();
    if (unobserved.length > 0) {
      await observe(unobserved);
      applyFold(runState, foldObservations(runState, observations, shapeOf));
    }
  } finally {
    await reader.close();
  }
  if (isDebug() && stats.rounds > 0) {
    console.error("[GitEnrich] PHASE: CODEGRAPH_CALLER_PARAM_TYPES", JSON.stringify(stats));
  }
  return fresh;
}

/** The spill's line spans grouped by file. */
async function spansByFile(spillPath: string): Promise<Map<string, SpillLineSpan[]>> {
  const spansOf = new Map<string, SpillLineSpan[]>();
  for (const span of await indexSpillLines(spillPath)) {
    if (span.relPath === "") continue;
    const held = spansOf.get(span.relPath);
    if (held === undefined) spansOf.set(span.relPath, [span]);
    else held.push(span);
  }
  return spansOf;
}

function groupBySourceFile(rows: readonly PersistedCallerArgObservation[]): Map<string, CallerArgObservation[]> {
  const out = new Map<string, CallerArgObservation[]>();
  for (const { sourceRelPath, observation } of rows) {
    const held = out.get(sourceRelPath);
    if (held === undefined) out.set(sourceRelPath, [observation]);
    else held.push(observation);
  }
  return out;
}

/** Add the callee files the scope can extract to the spill; the paths it appended. */
async function appendDependents(relPaths: readonly string[], scope: CallerParamPassScope): Promise<readonly RelPath[]> {
  if (relPaths.length === 0 || scope.appendToSpill === undefined) return [];
  return scope.appendToSpill(relPaths);
}

/** One fold's product: evidence, the agreed types, and the counters describing them. */
interface CallerParamFold {
  readonly evidence: CallerParamTypes;
  readonly agreed: Record<string, Record<string, RubyTypeRef>>;
  readonly observedSites: number;
}

/** Fold observations into parameter types; a name the barrier's constructor-arg fold typed keeps that answer. */
function foldObservations(
  runState: CodegraphRunState,
  observations: ReadonlyMap<string, readonly CallerArgObservation[]>,
  shapeOf: (symbolId: string) => CalleeParamShape | undefined,
): CallerParamFold {
  const bindings: { target: string; params: ReadonlyMap<string, CallerArgObservation["positional"][number]> }[] = [];
  let observedSites = 0;
  for (const relPath of [...observations.keys()].sort()) {
    for (const site of observations.get(relPath) ?? []) {
      observedSites += 1;
      const shape = shapeOf(site.target);
      const params = shape === undefined ? null : bindCallArgsToParams(site, shape);
      if (params !== null && params.size > 0) bindings.push({ target: site.target, params });
    }
  }
  const evidence = foldCallerParamTypes(bindings);
  const agreed = agreedCallerParamTypes(evidence);
  for (const [target, params] of Object.entries(agreed)) {
    for (const name of Object.keys(params)) {
      if (identifierEntry(runState.paramTypes, target)?.[name] !== undefined) delete params[name];
    }
    if (Object.keys(params).length === 0) delete agreed[target];
  }
  return { evidence, agreed, observedSites };
}

/** Leave a fold on `runState`: parameter types, evidence and counters. */
function applyFold(runState: CodegraphRunState, { evidence, agreed, observedSites }: CallerParamFold): void {
  runState.callerParamEvidence = evidence;
  runState.callerParamTypes = agreed;
  const stats = runState.stats.callerParamTyping;
  stats.observedSites = observedSites;
  stats.paramsTyped = 0;
  stats.paramsDisagreed = 0;
  stats.paramsOutnumbered = 0;
  stats.untypedCallers = 0;
  for (const params of Object.values(evidence)) {
    for (const entry of Object.values(params)) {
      stats.untypedCallers += entry.untypedCallers;
      if (entry.types.length > 1) stats.paramsDisagreed += 1;
      else if (entry.types.length === 1 && entry.agreed === undefined && entry.untypedCallers > entry.typedCallers) {
        stats.paramsOutnumbered += 1;
      }
    }
  }
  for (const params of Object.values(agreed)) stats.paramsTyped += Object.keys(params).length;
}

/** The files declaring any of `targets` that `keep` admits — where the calls on their parameters live — sorted. */
function filesDeclaring(
  targets: readonly string[],
  symbolTable: GlobalSymbolTable,
  keep: (relPath: string) => boolean,
): string[] {
  const files = new Set<string>();
  for (const target of targets) {
    const def = definitionOf(symbolTable, target);
    if (def !== undefined && keep(def.relPath)) files.add(def.relPath);
  }
  return [...files].sort();
}

/** One spill line, or `undefined` when it does not parse — pass-2 reports that line with its own context. */
function parseQuietly(line: string): FileExtraction | undefined {
  try {
    return JSON.parse(line) as FileExtraction;
  } catch {
    return undefined;
  }
}
