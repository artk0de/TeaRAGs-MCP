/**
 * Interprocedural PARAMETER typing at the pass-1→pass-2 barrier, Increment 1
 * (bd tea-rags-mcp-bvalc).
 *
 * Typing a method's parameters from its call sites normally needs a fixpoint —
 * call sites resolve in pass 2, parameter types would have to exist in pass 1
 * for that resolution to improve. Increment 1 dodges the fixpoint by folding
 * ONLY over call sites whose callee is known from syntax: `Const.new(args)` is
 * `Const#initialize` and a constant-receiver factory verb is `Const.<verb>`
 * whatever else the program does. The walker harvests those argument types
 * during pass 1 (`FileExtraction.knownTargetCallArgs`); this module folds them
 * once the run is complete, before a single call is resolved.
 *
 * The agreement rule is deliberately not a vote. Per parameter position:
 *   - every KNOWN hint agreeing on one type binds it — a single uncontradicted
 *     witness suffices;
 *   - an ABSENT hint neither votes nor vetoes (it is missing evidence, not
 *     evidence of another type);
 *   - ANY disagreement is silence for that position. Increment 1 never
 *     majority-votes, so a parameter that really is polymorphic stays untyped
 *     rather than acquiring its most popular caller's type.
 *
 * Nothing here defines a new consumption channel. The derived facts ride the
 * two that already exist and already lose to declarations: parameter types are
 * seeded into the chunk's `localBindings` exactly as a YARD `@param` would be
 * (and only where YARD left the name unbound), and `@ivar = <param>` copies are
 * completed into `classFieldTypes`, under everything the walker typed itself.
 */

import { createIdentifierRecord, identifierEntry } from "../../../../contracts/identifier-record.js";
import { typeRefEquals } from "../../../../contracts/type-ref-equals.js";
import type {
  ChunkExtraction,
  ClassFieldParamLink,
  KnownTargetCallArgs,
  KnownTargetCallee,
  KnownTargetCalleeLocator,
  LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { paramCoordinateOf } from "./param-family.js";

/** Run-global `"<fqType>#<member>" → paramName → type`, the fold's product. */
export type KnownTargetParamTypes = Record<string, Record<string, RubyTypeRef>>;

/** Sentinel for a position two call sites disagreed about — bound to nothing. */
const CONFLICTED = Symbol("conflicted");

/**
 * Fold known-target call-site argument types into per-callee parameter types.
 *
 * `paramNamesBySymbolId` is the run's method-definition index (populated from
 * `ChunkExtraction.paramNames` during pass 1). It does double duty: it maps an
 * argument POSITION to a parameter NAME, and — because it only holds real
 * definitions — it is the existence gate that picks which of a call site's
 * constant-lookup candidates is the actual callee. A call whose constant names
 * nothing in-project (a gem class, a typo) resolves to no candidate and
 * contributes nothing; a call whose argument sits past the callee's known
 * positional run is ignored for the same reason the walker truncated the list.
 */
export function foldKnownTargetParamTypes(
  records: Iterable<KnownTargetCallArgs>,
  paramNamesBySymbolId: Readonly<Record<string, readonly string[]>>,
): KnownTargetParamTypes {
  const byTarget = new Map<string, Map<number, RubyTypeRef | typeof CONFLICTED>>();
  for (const record of records) {
    const target = record.targets.find((candidate) => paramNamesBySymbolId[candidate] !== undefined);
    if (target === undefined) continue;
    const paramNames = paramNamesBySymbolId[target];
    const positions = byTarget.get(target) ?? new Map<number, RubyTypeRef | typeof CONFLICTED>();
    byTarget.set(target, positions);
    for (let i = 0; i < record.argTypes.length && i < paramNames.length; i++) {
      const hint = record.argTypes[i];
      if (hint === null || hint === undefined) continue; // absent evidence: no vote, no veto
      const seen = positions.get(i);
      if (seen === undefined) positions.set(i, hint);
      else if (seen !== CONFLICTED && !typeRefEquals(seen, hint)) positions.set(i, CONFLICTED);
    }
  }

  const out: KnownTargetParamTypes = createIdentifierRecord();
  for (const [target, positions] of byTarget) {
    const paramNames = paramNamesBySymbolId[target] ?? [];
    const params: Record<string, RubyTypeRef> = createIdentifierRecord();
    for (const [index, type] of positions) {
      const name = paramNames[index];
      if (name === undefined || type === CONFLICTED) continue;
      params[name] = type;
    }
    if (Object.keys(params).length > 0) out[target] = params;
  }
  return out;
}

/** The constructor an instance class inherits: the class that declares it, and its member name. */
export interface InheritedConstructor {
  readonly definingClassKey: string;
  readonly method: string;
}

/** {@link redirectKnownTargetCallArgs}'s product — the fold's two inputs, plus who inherits what. */
export interface RedirectedKnownTargetCallArgs {
  readonly records: readonly KnownTargetCallArgs[];
  /** The fold's def index, extended with each inheriting class's coordinate. */
  readonly paramNames: Readonly<Record<string, readonly string[]>>;
  /** Instance class key → the constructor it runs, for every call redirected up an ancestry. */
  readonly inheritedConstructors: ReadonlyMap<string, InheritedConstructor>;
}

/**
 * Re-address the known-target call sites no indexed def answers (bd
 * tea-rags-mcp-m99j1.1.42), BEFORE {@link foldKnownTargetParamTypes} runs.
 *
 * A record any candidate already indexes is passed through untouched and its
 * language's locator is never asked — every call that folded before folds
 * identically. Otherwise each candidate goes to the locator; the record is
 * redirected only when every answer names the SAME callee (two candidates
 * locating two classes is the ambiguity the walker refused to resolve) and that
 * callee's def has positional names. A redirected record folds into the
 * defining class's def, where the arguments really flow. When the constructor
 * is inherited it ALSO folds under the instance class's own coordinate, aliased
 * to the defining def's names: the fields that constructor assigns are
 * attributes of the INSTANCE, and keying them by the instance class means a
 * direct construction of the ancestor with other types cannot silence them.
 */
export function redirectKnownTargetCallArgs(
  records: Iterable<KnownTargetCallArgs>,
  paramNamesBySymbolId: Readonly<Record<string, readonly string[]>>,
  locatorOf: (record: KnownTargetCallArgs) => KnownTargetCalleeLocator | undefined,
): RedirectedKnownTargetCallArgs {
  const out: KnownTargetCallArgs[] = [];
  const aliases: Record<string, readonly string[]> = createIdentifierRecord();
  const inheritedConstructors = new Map<string, InheritedConstructor>();
  for (const record of records) {
    out.push(record);
    if (record.targets.some((target) => paramNamesBySymbolId[target] !== undefined)) continue;
    const locate = locatorOf(record);
    if (locate === undefined) continue;
    const callee = soleCallee(record.targets, locate);
    if (callee === null) continue;
    const coordinate = `${callee.definingClassKey}#${callee.method}`;
    const names = paramNamesBySymbolId[coordinate];
    if (names === undefined) continue;
    out.push({ targets: [coordinate], argTypes: record.argTypes });
    if (callee.instanceClassKey === callee.definingClassKey) continue;
    aliases[`${callee.instanceClassKey}#${callee.method}`] = names;
    out.push({ targets: [`${callee.instanceClassKey}#${callee.method}`], argTypes: record.argTypes });
    inheritedConstructors.set(callee.instanceClassKey, {
      definingClassKey: callee.definingClassKey,
      method: callee.method,
    });
  }
  const paramNames = Object.keys(aliases).length === 0 ? paramNamesBySymbolId : { ...paramNamesBySymbolId, ...aliases };
  return { records: out, paramNames, inheritedConstructors };
}

/** The one callee every locatable candidate agrees on, with the candidates' member, or `null`. */
function soleCallee(
  targets: readonly string[],
  locate: KnownTargetCalleeLocator,
): (KnownTargetCallee & { readonly method: string }) | null {
  let sole: (KnownTargetCallee & { readonly method: string }) | null = null;
  for (const target of targets) {
    const at = target.lastIndexOf("#");
    if (at <= 0) continue;
    const located = locate(target);
    if (located === null) continue;
    const method = target.slice(at + 1);
    if (sole === null) sole = { ...located, method };
    else if (
      sole.definingClassKey !== located.definingClassKey ||
      sole.instanceClassKey !== located.instanceClassKey ||
      sole.method !== method
    ) {
      return null;
    }
  }
  return sole;
}

/**
 * Hand each inheriting class the links its inherited constructor declares
 * (bd tea-rags-mcp-m99j1.1.42), so the derivation keys `self.<field> = <param>`
 * on the INSTANCE class as well as on the class that wrote it — Python sets
 * the attribute on the object under construction, whatever class declared the
 * `__init__`. Only the constructor's own links travel; the instance class's own
 * link at a shared field wins. Nothing inherited ⇒ the links by identity.
 */
export function inheritConstructorFieldLinks(
  links: Readonly<Record<string, Readonly<Record<string, ClassFieldParamLink>>>>,
  inherited: ReadonlyMap<string, InheritedConstructor>,
): Readonly<Record<string, Readonly<Record<string, ClassFieldParamLink>>>> {
  let out: Record<string, Readonly<Record<string, ClassFieldParamLink>>> | undefined;
  for (const [instanceClassKey, { definingClassKey, method }] of inherited) {
    const constructorLinks: Record<string, ClassFieldParamLink> = createIdentifierRecord();
    for (const [field, link] of Object.entries(identifierEntry(links, definingClassKey) ?? {})) {
      if (link.method === method) constructorLinks[field] = link;
    }
    if (Object.keys(constructorLinks).length === 0) continue;
    out ??= { ...links };
    out[instanceClassKey] = { ...constructorLinks, ...identifierEntry(links, instanceClassKey) };
  }
  return out ?? links;
}

/**
 * Extend a typed-field gate (`"<classKey>|<field>"`) to the inheriting classes:
 * a field the DEFINING class typed on its own is typed for the instance class
 * too, so the derivation never keys a weaker fact where an ancestor-chain read
 * would meet it first. Nothing inherited ⇒ the gate by identity.
 */
export function inheritTypedFields(
  typed: ReadonlySet<string>,
  inherited: ReadonlyMap<string, InheritedConstructor>,
): ReadonlySet<string> {
  if (inherited.size === 0) return typed;
  const heirs = new Map<string, string[]>();
  for (const [instanceClassKey, { definingClassKey }] of inherited) {
    heirs.set(definingClassKey, [...(heirs.get(definingClassKey) ?? []), instanceClassKey]);
  }
  const out = new Set(typed);
  for (const coordinate of typed) {
    const bar = coordinate.lastIndexOf("|");
    for (const heir of heirs.get(coordinate.slice(0, bar)) ?? []) out.add(`${heir}${coordinate.slice(bar)}`);
  }
  return out;
}

/**
 * Complete `@ivar = <param>` copies into `classFieldTypes` entries, joining the
 * walker's `(class, ivar) → (method, param)` links against the folded parameter
 * types.
 *
 * `declaredFields` holds `"fqClass|@ivar"` for every field the walker typed
 * itself anywhere in the run (a `@x = Const.new`, a YARD-annotated parameter
 * copy, an association chain). Those coordinates are SKIPPED — derived facts
 * never overwrite inferred or declared ones, and the run-global check also
 * covers a class reopened across files, where a per-file check would not see
 * the competing assignment.
 *
 * A CLASS-valued parameter derives nothing: `classFieldTypes` values are read
 * back as instance types (`ivarTypeName` → `{form:"instance"}`), so recording a
 * class there would dispatch `@x.foo` to `Type#foo` when the runtime calls
 * `Type.foo`. Container and union refs are likewise skipped — the channel is
 * string-valued and cannot carry them.
 */
export function deriveClassFieldTypesFromParams(
  links: Readonly<Record<string, Readonly<Record<string, ClassFieldParamLink>>>>,
  paramTypes: KnownTargetParamTypes,
  declaredFields: ReadonlySet<string>,
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = createIdentifierRecord();
  for (const [fqClass, fields] of Object.entries(links)) {
    for (const [ivar, link] of Object.entries(fields)) {
      if (declaredFields.has(`${fqClass}|${ivar}`)) continue;
      const type = paramTypes[`${fqClass}#${link.method}`]?.[link.param];
      if (type?.form !== "instance") continue;
      (out[fqClass] ??= createIdentifierRecord())[ivar] = type.name;
    }
  }
  return out;
}

/**
 * Seed a method chunk's `localBindings` with the parameter types the barrier
 * derived, at the definition line — the same coordinate and the same channel a
 * YARD `@param` occupies, so every downstream reader (the receiver-kind
 * classifier, the local-type strategy, the chain engine) sees one kind of fact.
 *
 * A name ALREADY bound in the chunk keeps its binding untouched and the whole
 * map is returned by identity: YARD and the walker's own AST inference win, and
 * a chunk with nothing to add allocates nothing. A chunk with no start line
 * gets nothing — a `LocalBinding` without a position cannot be looked up.
 */
export function seedParamLocalBindings(
  localBindings: Record<string, LocalBinding[]> | undefined,
  paramTypes: Readonly<Record<string, RubyTypeRef>> | undefined,
  defLine: number | undefined,
): Record<string, LocalBinding[]> | undefined {
  if (paramTypes === undefined || defLine === undefined) return localBindings;
  let seeded: Record<string, LocalBinding[]> | undefined;
  for (const [name, type] of Object.entries(paramTypes)) {
    if (localBindings?.[name] !== undefined) continue; // declared/inferred wins
    if (type.form !== "instance" && type.form !== "class") continue; // union/container: not a param binding
    const binding: LocalBinding = { line: defLine, type: type.name };
    if (type.form === "class") binding.valueKind = "class";
    seeded ??= { ...localBindings };
    seeded[name] = [binding];
  }
  return seeded ?? localBindings;
}

/**
 * The folded parameter types of the def `chunk` holds, read under its fold
 * coordinate (`paramCoordinate`, else `symbolId` — bd tea-rags-mcp-m99j1.1.17),
 * so a walker whose class key is not its symbolId prefix is still found.
 */
export function paramTypesOfChunk(
  paramTypes: KnownTargetParamTypes,
  chunk: Pick<ChunkExtraction, "symbolId" | "paramCoordinate">,
): Readonly<Record<string, RubyTypeRef>> | undefined {
  return identifierEntry(paramTypes, paramCoordinateOf(chunk));
}

/**
 * Overlay the run's derived class-field types under a file's own map. The
 * file's entries always win at a shared coordinate (they are inference or
 * declaration; the overlay is derivation), and an empty overlay returns the
 * file's map by IDENTITY so a run that derived nothing is allocation-free and
 * byte-identical to one without the mechanism.
 */
export function mergeDerivedClassFieldTypes(
  own: Record<string, Record<string, string>> | undefined,
  derived: Readonly<Record<string, Record<string, string>>>,
): Record<string, Record<string, string>> | undefined {
  const classes = Object.keys(derived);
  if (classes.length === 0) return own;
  const merged: Record<string, Record<string, string>> = { ...own };
  for (const fqClass of classes) {
    merged[fqClass] = { ...derived[fqClass], ...own?.[fqClass] };
  }
  return merged;
}
