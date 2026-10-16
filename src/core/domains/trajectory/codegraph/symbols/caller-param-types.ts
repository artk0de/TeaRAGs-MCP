/**
 * Parameter types from statically resolved callers (bd tea-rags-mcp-2m83f.44) —
 * the language-agnostic half, beside Increment 1's fold (`call-arg-param-types.ts`): binding a call site's arguments to the callee's
 * parameters, folding the bindings of every caller into one answer per
 * parameter, and the round bound of the fixpoint that re-observes callers once
 * a parameter they forward has been typed.
 *
 * A language supplies the two halves that are its own: the TYPE of each
 * argument expression at the call site, and the callee's parameter SHAPE.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import { typeRefEquals } from "../../../../contracts/type-ref-equals.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";

/** Rounds of caller → parameter → forwarded-argument propagation, the first one included. */
export const CALLER_PARAM_MAX_ROUNDS = 3;

/** One call site whose callee is a single exact static edge, with each argument's type or `null` when untyped. */
export interface CallerArgObservation {
  /** The callee's symbolId — the parameter-typing coordinate. */
  readonly target: string;
  /** Per position, up to the first argument that breaks positional correspondence. */
  readonly positional: readonly (RubyTypeRef | null)[];
  /** Keyword argument name → type. */
  readonly keyword?: Readonly<Record<string, RubyTypeRef | null>>;
  /** Positional argument count; absent when a splat makes it unknowable. */
  readonly argCount?: number;
  readonly hasKwargSplat?: boolean;
}

/** What the binder needs to know about the callee's parameter list. */
export interface CalleeParamShape {
  /** The leading run of plain required positional names. */
  readonly positional: readonly string[];
  /** Positional capacity; absent when unknown. */
  readonly maxPositional?: number;
  readonly hasRestPositional?: boolean;
  /** Declared keyword names (required ∪ optional); absent when unknown. */
  readonly keywords?: readonly string[];
  readonly hasKeywordRest?: boolean;
}

/**
 * The callee parameters one call site binds, each to its argument's type or to
 * `null` (an untyped caller for that parameter). `null` for the whole site when
 * its argument count does not fit the callee — the edge and the signature
 * disagree, so the site is no evidence at all.
 *
 * Refusals: a positional splat binds no positional parameter (its width is
 * unknown); a `**opts` binds no keyword parameter; a keyword the callee does not
 * declare, or a callee whose keywords are unknown, binds nothing. A declared
 * keyword the site does not pass takes its default — an untyped caller for it.
 */
export function bindCallArgsToParams(
  site: CallerArgObservation,
  shape: CalleeParamShape,
): Map<string, RubyTypeRef | null> | null {
  const { argCount } = site;
  if (
    argCount !== undefined &&
    shape.maxPositional !== undefined &&
    shape.hasRestPositional !== true &&
    argCount > shape.maxPositional
  ) {
    return null;
  }
  const bound = new Map<string, RubyTypeRef | null>();
  if (argCount !== undefined) {
    for (let i = 0; i < shape.positional.length && i < argCount; i++) {
      bound.set(shape.positional[i], site.positional[i] ?? null);
    }
  }
  if (site.hasKwargSplat !== true && shape.keywords !== undefined) {
    for (const name of shape.keywords) {
      if (bound.has(name)) continue;
      const passed = site.keyword !== undefined && Object.hasOwn(site.keyword, name);
      bound.set(name, passed ? (site.keyword?.[name] ?? null) : null);
    }
  }
  return bound;
}

/** Everything the callers said about one parameter. */
export interface CallerParamEvidence {
  /** The single type every typed caller agrees on, when the agreement rule admits it. */
  readonly agreed?: RubyTypeRef;
  /** Distinct types the typed callers passed, in first-seen order. */
  readonly types: readonly RubyTypeRef[];
  readonly typedCallers: number;
  readonly untypedCallers: number;
}

/** One parameter's running tally inside {@link foldCallerParamTypes}. */
interface ParamTally {
  types: RubyTypeRef[];
  typed: number;
  untyped: number;
}

/** `callee symbolId → parameter name → evidence`. */
export type CallerParamTypes = Readonly<Record<string, Readonly<Record<string, CallerParamEvidence>>>>;

/**
 * Fold the bindings of every caller into evidence per parameter, and decide
 * which parameters are typed.
 *
 * A parameter is typed only when (a) at least one caller is typed, (b) every
 * typed caller passes the SAME type, of instance or class form, and (c) the
 * untyped callers do not outnumber the typed ones. A disagreement types nothing
 * — no common-ancestor join here; the evidence keeps every type so a consumer
 * that can intersect member sets (the receiver constraint set) reads them. (c)
 * is the precision guard: one typed caller among many untyped ones is a sample,
 * not a contract, and an untyped caller may pass anything.
 */
export function foldCallerParamTypes(
  bindings: Iterable<{ readonly target: string; readonly params: ReadonlyMap<string, RubyTypeRef | null> }>,
): CallerParamTypes {
  const acc = new Map<string, Map<string, ParamTally>>();
  for (const { target, params } of bindings) {
    let byParam = acc.get(target);
    if (byParam === undefined) acc.set(target, (byParam = new Map<string, ParamTally>()));
    for (const [name, type] of params) {
      let entry = byParam.get(name);
      if (entry === undefined) byParam.set(name, (entry = { types: [], typed: 0, untyped: 0 }));
      if (type === null) {
        entry.untyped += 1;
        continue;
      }
      entry.typed += 1;
      if (!entry.types.some((seen) => typeRefEquals(seen, type))) entry.types.push(type);
    }
  }
  const out: Record<string, Record<string, CallerParamEvidence>> = createIdentifierRecord();
  for (const [target, byParam] of acc) {
    const params: Record<string, CallerParamEvidence> = createIdentifierRecord();
    for (const [name, { types, typed, untyped }] of byParam) {
      const sole = types.length === 1 ? types[0] : undefined;
      const admitted = sole !== undefined && (sole.form === "instance" || sole.form === "class") && untyped <= typed;
      params[name] = {
        ...(admitted ? { agreed: sole } : {}),
        types,
        typedCallers: typed,
        untypedCallers: untyped,
      };
    }
    out[target] = params;
  }
  return out;
}

/** `callee → parameter → type` for the parameters {@link foldCallerParamTypes} typed. */
export function agreedCallerParamTypes(evidence: CallerParamTypes): Record<string, Record<string, RubyTypeRef>> {
  const out: Record<string, Record<string, RubyTypeRef>> = createIdentifierRecord();
  for (const [target, params] of Object.entries(evidence)) {
    for (const [name, { agreed }] of Object.entries(params)) {
      if (agreed !== undefined) (out[target] ??= createIdentifierRecord())[name] = agreed;
    }
  }
  return out;
}

/** Callees whose typed parameters differ between two agreed maps — the ones a next round must re-observe from. */
export function changedCallerParamTargets(
  before: Readonly<Record<string, Readonly<Record<string, RubyTypeRef>>>>,
  after: Readonly<Record<string, Readonly<Record<string, RubyTypeRef>>>>,
): string[] {
  const changed: string[] = [];
  for (const target of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[target] ?? {};
    const b = after[target] ?? {};
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const name of names) {
      const x = a[name];
      const y = b[name];
      if (x === undefined || y === undefined ? x !== y : !typeRefEquals(x, y)) {
        changed.push(target);
        break;
      }
    }
  }
  return changed.sort();
}
