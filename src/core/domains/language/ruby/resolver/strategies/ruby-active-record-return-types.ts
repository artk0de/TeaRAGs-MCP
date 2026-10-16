/**
 * The ActiveRecord query interface as a RETURN-TYPE vocabulary (G1b).
 *
 * Rails defines `find` / `create!` / `where` / `order` on every model without a
 * line of project code declaring them, so no fact channel can answer for them.
 * This module states what they yield — the model for the instance-returning
 * finders and factories, a relation (`container(model)`) for the query methods
 * — gated on the receiver actually descending from an AR model base.
 *
 * It is deliberately the LAST channel `returnTypeOf` consults: a
 * declared fact always beats vocabulary. Split out of `type-propagation.ts`
 * (bd tea-rags-mcp-uetqq) with the gate and the vocabulary unchanged.
 */

import { identifierEntry } from "../../../../../contracts/identifier-record.js";
import type { CallContext, SymbolDefinitionKind } from "../../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
import { substituteRelationSelf } from "../../../kernel/index.js";
import { ACTIVE_RECORD_QUERY_INTERFACE, catalogueFor } from "../../dsl/index.js";

/**
 * Whether `className`'s transitive ancestry (walking `ctx.classAncestors`,
 * cycle-guarded by `seen`) reaches any class in `targets`. A local membership
 * predicate rather than the strategies' `collectAncestorChain`: importing that
 * would pull `strategies/shared.ts` → `walker.ts` → `type-sources/ast-inference`
 * → back into the propagation cluster, a module cycle that breaks the
 * `CONTAINER_*` const init in `ruby-member-return-types.ts`. `className` itself
 * counts (a call on `ApplicationRecord` directly).
 */
function ancestryReaches(
  className: string,
  targets: ReadonlySet<string>,
  ctx: CallContext,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(className)) return false;
  seen.add(className);
  if (targets.has(className)) return true;
  for (const ancestor of identifierEntry(ctx.classAncestors, className) ?? []) {
    if (ancestryReaches(ancestor, targets, ctx, seen)) return true;
  }
  return false;
}

/**
 * The model a RELATION ranges over — `container(Model)` whose element is an
 * instance of a class descending from an AR model base — or `undefined` for any
 * other ref (bd tea-rags-mcp-89k7k.35.29).
 *
 * A relation is not an opaque collection: Rails delegates every member it does
 * not define itself to the model's CLASS (`scoping { klass.public_send(…) }`), so
 * a scope or `def self.` on the model is callable on it and answers over the
 * model again. A container over anything else (a plain `Array<Foo>`, a gem
 * class) delegates nothing and stays the opaque collection it always was.
 */
export function activeRecordRelationModel(ref: RubyTypeRef | undefined, ctx: CallContext): string | undefined {
  if (ref?.form !== "container" || ref.element.form !== "instance") return undefined;
  const model = ref.element.name;
  return ancestryReaches(model, ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses, ctx) ? model : undefined;
}

const MODULE_KIND: ReadonlySet<SymbolDefinitionKind> = new Set(["module"]);
const CLASS_KIND: ReadonlySet<SymbolDefinitionKind> = new Set(["class"]);

/**
 * A constant the run declares as a MODULE and never as a class — whose
 * "instance" no Ruby program can hold (bd tea-rags-mcp-89k7k.35.29). A project
 * monkey-patch reopening a gem's namespace (`module Faraday; module Utils`)
 * declares the module, so `Faraday.new(…)` — a module function answering a gem
 * class — would otherwise type its result as a project `Faraday` instance.
 */
export function isModuleOnlyConstant(name: string, ctx: CallContext): boolean {
  return (
    ctx.symbolTable.lookup(name, { kinds: MODULE_KIND }).length > 0 &&
    ctx.symbolTable.lookup(name, { kinds: CLASS_KIND }).length === 0
  );
}

/**
 * `type` as answered for a member called on `receiverModel` (bd
 * tea-rags-mcp-2m83f.32.3): a scope a concern declares in `included do` is
 * stated over the CONCERN (`SoftDeletable#without_deleted` → relation of
 * `SoftDeletable`), but sent to an AR model it is a relation of that model.
 * Only a relation that then reads as an AR relation is substituted; any other
 * answer is returned as is.
 */
export function createRubyTypeRefOverReceiver(type: RubyTypeRef, receiverModel: string, ctx: CallContext): RubyTypeRef {
  const substituted = substituteRelationSelf(type, receiverModel, (name) => isModuleOnlyConstant(name, ctx));
  return substituted !== type && activeRecordRelationModel(substituted, ctx) !== undefined ? substituted : type;
}

/** `find_by_<attr>` / `find_by_<attr>!` — a dynamic finder (requires an attr suffix). */
function isDynamicFinder(member: string): boolean {
  const prefix = ACTIVE_RECORD_QUERY_INTERFACE.dynamicFinderPrefix;
  return member.startsWith(prefix) && member.length > prefix.length;
}

/**
 * ActiveRecord query-interface fallback (G1b): on an AR-model receiver, the
 * Rails-defined query methods resolve WITHOUT per-model facts. Instance-returning
 * finders/factories (`find`, `create!`, `find_by_<attr>`) yield the model;
 * relation-returning query methods (`where`, `order`, …) yield a relation
 * (`container(model)`). Returns `undefined` when the receiver is not an AR model
 * or the member is not query vocabulary — the caller then falls through to
 * `undefined` (no fabrication).
 */
export function activeRecordQueryReturn(className: string, member: string, ctx: CallContext): RubyTypeRef | undefined {
  if (!ancestryReaches(className, ACTIVE_RECORD_QUERY_INTERFACE.modelBaseClasses, ctx)) return undefined;
  const catalogue = catalogueFor(ctx.declaredDependencies);
  if (catalogue.instanceReturning.has(member) || isDynamicFinder(member)) {
    return { form: "instance", name: className };
  }
  if (catalogue.relationReturning.has(member)) {
    return { form: "container", element: { form: "instance", name: className } };
  }
  return undefined;
}
