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
import type { CallContext } from "../../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../contracts/types/language.js";
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
