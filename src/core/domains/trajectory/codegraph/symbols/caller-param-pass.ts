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
 * working-tree build share it. Scope is the spill: a caller the run did not walk
 * is not observed.
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type { FileExtraction, GlobalSymbolTable, SymbolDefinition } from "../../../../contracts/types/codegraph.js";
import { isDebug } from "../../../../primitives/diagnostics/index.js";
import {
  agreedCallerParamTypes,
  bindCallArgsToParams,
  CALLER_PARAM_MAX_ROUNDS,
  changedCallerParamTargets,
  foldCallerParamTypes,
  type CalleeParamShape,
  type CallerArgObservation,
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
 * Run the pass and leave its product on `runState` (`callerParamTypes`,
 * `callerParamEvidence`, `stats.callerParamTyping`). A spill with no observable
 * call site leaves everything empty.
 */
export async function runCallerParamPass(
  spillPath: string,
  observer: CallerArgObserver,
  runState: CodegraphRunState,
  symbolTable: GlobalSymbolTable,
): Promise<void> {
  const spans = await indexSpillLines(spillPath);
  const spansOf = new Map<string, SpillLineSpan[]>();
  for (const span of spans) {
    if (span.relPath === "") continue;
    const held = spansOf.get(span.relPath);
    if (held === undefined) spansOf.set(span.relPath, [span]);
    else held.push(span);
  }
  const observations = new Map<string, CallerArgObservation[]>();
  const shapes = new Map<string, CalleeParamShape | undefined>();
  const shapeOf = (symbolId: string): CalleeParamShape | undefined => {
    if (!shapes.has(symbolId)) shapes.set(symbolId, calleeShapeOf(runState, symbolTable, symbolId));
    return shapes.get(symbolId);
  };
  const stats = runState.stats.callerParamTyping;
  const reader = await SpillLineReader.open(spillPath);
  try {
    let pending = [...spansOf.keys()].sort();
    for (let round = 1; round <= CALLER_PARAM_MAX_ROUNDS && pending.length > 0; round++) {
      for (const relPath of pending) {
        const observed: CallerArgObservation[] = [];
        for (const span of spansOf.get(relPath) ?? []) {
          const extraction = parseQuietly(await reader.read(span));
          if (extraction !== undefined) observed.push(...observer.observeCallerArgs(extraction, symbolTable));
        }
        if (observed.length > 0) observations.set(relPath, observed);
        else observations.delete(relPath);
      }
      stats.rounds = round;
      const before = runState.callerParamTypes;
      foldInto(runState, observations, shapeOf);
      pending = filesDeclaring(changedCallerParamTargets(before, runState.callerParamTypes), symbolTable, spansOf);
    }
  } finally {
    await reader.close();
  }
  if (isDebug() && stats.rounds > 0) {
    console.error("[GitEnrich] PHASE: CODEGRAPH_CALLER_PARAM_TYPES", JSON.stringify(stats));
  }
}

/** Fold every current observation into `runState`'s parameter types, evidence and counters. */
function foldInto(
  runState: CodegraphRunState,
  observations: ReadonlyMap<string, readonly CallerArgObservation[]>,
  shapeOf: (symbolId: string) => CalleeParamShape | undefined,
): void {
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
  // A name the barrier's constructor-arg fold typed keeps that answer.
  for (const [target, params] of Object.entries(agreed)) {
    for (const name of Object.keys(params)) {
      if (identifierEntry(runState.paramTypes, target)?.[name] !== undefined) delete params[name];
    }
    if (Object.keys(params).length === 0) delete agreed[target];
  }
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

/** The spilled files declaring any of `targets` — where the calls on their parameters live — sorted. */
function filesDeclaring(
  targets: readonly string[],
  symbolTable: GlobalSymbolTable,
  spansOf: ReadonlyMap<string, readonly SpillLineSpan[]>,
): string[] {
  const files = new Set<string>();
  for (const target of targets) {
    const def = definitionOf(symbolTable, target);
    if (def !== undefined && spansOf.has(def.relPath)) files.add(def.relPath);
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
