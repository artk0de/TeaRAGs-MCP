/**
 * Framework and core members whose project namesakes the call cannot reach
 * (bd tea-rags-mcp-2m83f.24):
 *
 * - a Rails framework instance member on an UNTYPED receiver — `form.save!`,
 *   `value.presence`, `period.days`. The callee is ActiveRecord / ActiveModel /
 *   ActiveSupport unless an instance-method namesake lives where an AR model
 *   instance reaches it: a model, `ApplicationRecord`, a module a model mixes in
 *   (schema columns included), a top-level def, or a reopened core class.
 *   A class-method namesake (`Schedule.save!`) never answers an instance call.
 * - any member on a LITERAL receiver — `7.days`, `"a,b".split`. The receiver's
 *   class is the literal's core class; only a project patch of that class (or of
 *   a module it mixes in) can be the callee.
 *
 * Both read the walker's ancestry, which cannot see every mixin: a class in the
 * reachable set carrying an unresolved mixin (`include some_var`, bd
 * tea-rags-mcp-2m83f.48) may reach any module, so then every namesake that may
 * live on a module blocks the claim.
 */
import type { CallContext, SymbolDefinitionKind } from "../../../../contracts/types/codegraph.js";
import { ACTIVE_RECORD_QUERY_INTERFACE, RAILS_UNTYPED_RECEIVER_MEMBERS } from "../dsl/index.js";
import { lastConstantSegment, lookupRubySymbolsByShortName, railsVocabularyActive } from "./strategies/index.js";

/** Classes a project reopens to patch the runtime every receiver shares. */
const REOPENED_RUNTIME_OWNERS: ReadonlySet<string> = new Set([
  "Object",
  "BasicObject",
  "Kernel",
  "NilClass",
  "String",
  "Symbol",
  "Integer",
  "Float",
  "Numeric",
  "BigDecimal",
  "Array",
  "Hash",
  "Enumerable",
  "Date",
  "Time",
  "DateTime",
  "ActiveSupport::TimeWithZone",
  "ActiveRecord::Base",
]);

const modelHierarchyByAncestors = new WeakMap<Readonly<Record<string, readonly string[]>>, ReadonlySet<string>>();

function reachesModelBase(
  name: string,
  ancestors: Readonly<Record<string, readonly string[]>>,
  seen: Set<string>,
): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  if (ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses.has(name)) return true;
  const parents = Object.hasOwn(ancestors, name) ? ancestors[name] : [];
  return parents.some((parent) => reachesModelBase(parent, ancestors, seen));
}

function collectAncestors(
  name: string,
  ancestors: Readonly<Record<string, readonly string[]>>,
  into: Set<string>,
): void {
  if (into.has(name)) return;
  into.add(name);
  for (const parent of Object.hasOwn(ancestors, name) ? ancestors[name] : []) collectAncestors(parent, ancestors, into);
}

/** Every model and every ancestor of one (its concerns, `ApplicationRecord`), by full name and last segment —
 * a last-segment match errs toward blocking, the precision side. */
function modelHierarchy(ancestors: Readonly<Record<string, readonly string[]>>): ReadonlySet<string> {
  const cached = modelHierarchyByAncestors.get(ancestors);
  if (cached !== undefined) return cached;
  const members = new Set<string>(ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses);
  for (const name of Object.keys(ancestors)) {
    if (reachesModelBase(name, ancestors, new Set())) collectAncestors(name, ancestors, members);
  }
  const names = new Set<string>();
  for (const name of members) {
    names.add(name);
    // `ActiveRecord::Base` stays whole: its last segment would claim every `Foo::Base`.
    if (!ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses.has(name)) names.add(lastConstantSegment(name));
  }
  modelHierarchyByAncestors.set(ancestors, names);
  return names;
}

/** The class an instance-method namesake is defined on; `""` at top level, `null` for a class method. */
function instanceOwnerOf(symbolId: string): string | null {
  const hash = symbolId.lastIndexOf("#");
  const dot = symbolId.lastIndexOf(".");
  if (dot > hash) return null;
  return hash === -1 ? "" : symbolId.slice(0, hash);
}

const MODULE_KIND: ReadonlySet<SymbolDefinitionKind> = new Set(["module"]);
const CLASS_KIND: ReadonlySet<SymbolDefinitionKind> = new Set(["class"]);

/** A reachable class (full name or last segment) carries a mixin the walker could not read. */
function reachesUnreadMixin(reachable: ReadonlySet<string>, ctx: CallContext): boolean {
  for (const fq of ctx.unresolvedMixinClasses ?? []) {
    if (reachable.has(fq) || reachable.has(lastConstantSegment(fq))) return true;
  }
  return false;
}

/** False only for an owner declared as a class and never as a module (a kindless row counts as either). */
function mayBeModule(owner: string, ctx: CallContext): boolean {
  const { symbolTable } = ctx;
  return (
    symbolTable.lookup(owner, { kinds: MODULE_KIND }).length > 0 ||
    symbolTable.lookup(owner, { kinds: CLASS_KIND }).length === 0
  );
}

/** Instance-method namesakes of `member` with their owners, schema columns included. */
function instanceNamesakes(member: string, ctx: CallContext): { symbolId: string; owner: string }[] {
  return lookupRubySymbolsByShortName(ctx, member, { role: "callee", includeSchemaColumns: true }).flatMap((def) => {
    const owner = instanceOwnerOf(def.symbolId);
    return owner === null ? [] : [{ symbolId: def.symbolId, owner }];
  });
}

/** Instance-method owners of every Ruby namesake of `member`, schema columns included. */
function instanceOwners(member: string, ctx: CallContext): string[] {
  return instanceNamesakes(member, ctx).map(({ owner }) => owner);
}

/**
 * The receiver is untyped (the caller's check). `null` when the rule does not
 * apply — Rails inactive, the member outside {@link RAILS_UNTYPED_RECEIVER_MEMBERS},
 * no ancestry facts. Otherwise the namesakes an AR model instance may reach,
 * sorted: empty means the call targets the framework, non-empty is the menu of
 * overrides the call may land on (bd tea-rags-mcp-2m83f.48).
 */
export function railsReachableOverrides(member: string, ctx: CallContext): string[] | null {
  if (!RAILS_UNTYPED_RECEIVER_MEMBERS.has(member) || !railsVocabularyActive(ctx)) return null;
  const ancestors = ctx.classAncestors;
  if (ancestors === undefined) return null;
  const hierarchy = modelHierarchy(ancestors);
  const open = reachesUnreadMixin(hierarchy, ctx);
  const reachable = instanceNamesakes(member, ctx).filter(
    ({ owner }) =>
      owner === "" ||
      REOPENED_RUNTIME_OWNERS.has(owner) ||
      hierarchy.has(owner) ||
      hierarchy.has(lastConstantSegment(owner)) ||
      (open && mayBeModule(owner, ctx)),
  );
  return [...new Set(reachable.map(({ symbolId }) => symbolId))].sort();
}

/** True when the rule applies and no namesake can be the override the call reaches. */
export function railsMemberTargetsFramework(member: string, ctx: CallContext): boolean {
  return railsReachableOverrides(member, ctx)?.length === 0;
}

/** The core class a literal receiver evaluates to: `7` → Integer, `"a"` → String, `%w[a]` → Array. */
export function rubyLiteralClass(receiver: string): string | undefined {
  if (/^-?\d[\d_]*$/.test(receiver)) return "Integer";
  if (/^-?\d[\d_]*\.\d[\d_]*(?:e-?\d+)?$/.test(receiver)) return "Float";
  if (/^"(?:[^"\\]|\\.)*"$/.test(receiver) || /^'(?:[^'\\]|\\.)*'$/.test(receiver)) return "String";
  if (/^:[A-Za-z_]\w*[?!=]?$/.test(receiver)) return "Symbol";
  if (/^%[wWiI]\[[^\]]*\]$/.test(receiver)) return "Array";
  return undefined;
}

/** What a literal's core class answers to before any project patch: its own class and its core ancestors. */
const LITERAL_CORE_ANCESTRY: Readonly<Record<string, readonly string[]>> = {
  Integer: ["Integer", "Numeric", "Comparable"],
  Float: ["Float", "Numeric", "Comparable"],
  String: ["String", "Comparable"],
  Symbol: ["Symbol", "Comparable"],
  Array: ["Array", "Enumerable"],
};

/**
 * A call on a literal of `literalClass` reaches no project def: no instance
 * namesake patches that class, a core ancestor of it, `Object` / `Kernel` /
 * `BasicObject`, a module the project mixes into any of them, or the top level.
 */
export function literalMemberIsExternal(literalClass: string, member: string, ctx: CallContext): boolean {
  const reachable = new Set<string>();
  for (const core of [...(LITERAL_CORE_ANCESTRY[literalClass] ?? [literalClass]), "Object", "Kernel", "BasicObject"]) {
    collectAncestors(core, ctx.classAncestors ?? {}, reachable);
  }
  for (const name of [...reachable]) reachable.add(lastConstantSegment(name));
  const open = reachesUnreadMixin(reachable, ctx);
  return instanceOwners(member, ctx).every(
    (owner) =>
      owner !== "" &&
      !reachable.has(owner) &&
      !reachable.has(lastConstantSegment(owner)) &&
      !(open && mayBeModule(owner, ctx)),
  );
}
