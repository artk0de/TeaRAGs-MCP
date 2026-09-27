/**
 * Recognition of the **factory-returned object literal** — the object a NAMED
 * function hands back as its value:
 *
 *   export function createDeletionOutcome(paths: string[]): DeletionOutcome {
 *     return { markFailed(p) { … }, isFullSuccess() { … } };
 *   }
 *   export const createCounter = (start: number) => ({ increment(step) { … } });
 *
 * Its methods are invoked on the function's RESULT (`outcome.isFullSuccess()`),
 * with `this` bound to the literal — the instance a class constructor would
 * have produced. So per `.claude/rules/symbolid-convention.md` they join their
 * factory with `#`, exactly as a class-property arrow joins its class
 * (`class F { request = async () => {} }` → `F#request`), and
 * `createDeletionOutcome#isFullSuccess` is the id both producers write
 * (bd tea-rags-mcp-39xca.19).
 *
 * Lives in `infra/symbolid` for the reason its siblings do: `classifyMethod`
 * consults it, and `classifyMethod` is what the chunker (Qdrant payload
 * `symbolId`) and the codegraph walker (`cg_symbols.symbol_id`) BOTH read, so
 * one answer reaches both.
 *
 * ## What qualifies, and why each boundary sits where it does
 *
 * The id composes the member under the NEAREST NAMED enclosing symbol, so the
 * `#` is only honest when that symbol IS the function whose value the literal
 * is. The gate therefore demands both halves:
 *
 *   - the literal is the function's VALUE: the argument of a `return`, or the
 *     expression body of an arrow — seen through `as` / `satisfies` / parens;
 *   - that function is one the walker NAMES: a `function_declaration`, a
 *     `method_definition` (`Svc#build#m` — the value of an instance method's
 *     call), or a function expression / arrow bound by a declarator
 *     `functionValuedDeclaratorName` accepts.
 *
 * Deliberately declined, each keeping the namespace `.` it had:
 *
 *   - **A named literal** (`const api = { m() {} }`, returned or not). The id
 *     names the LITERAL itself (`buildApi.api.m`), and a member invoked on the
 *     object it belongs to is the const-object namespace form
 *     (`./const-object-namespace.ts`) — the static-only-class analogue.
 *   - **An anonymous callback's value** (`install(() => ({ handle() {} }))`).
 *     The nearest named symbol is the OUTER function, whose value the literal
 *     is not; a `#` would claim `register` returns something it never does.
 *   - **A call argument** (`install({ handle() {} })`) — not a value of the
 *     enclosing function at all.
 *   - **Class-field and assignment-bound functions** (`build = () => ({…})`,
 *     `exports.make = function () { return {…} }`). Named by grammar-specific
 *     gates the chunker does not share; widening here without evidence would
 *     trade one consistent `.` for a `#` only one producer composes.
 */

import type { AstNode } from "../../contracts/types/ast.js";
import { functionValuedDeclaratorName } from "./const-bound-function.js";

/** Type-level wrappers between a returned expression and the value underneath. */
const VALUE_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  "as_expression",
  "satisfies_expression",
  "parenthesized_expression",
]);

/** Node types that own a `return`; the nearest one is the function returning. */
const FUNCTION_TYPES: ReadonlySet<string> = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/**
 * Is `object` the object literal a named function returns — the literal whose
 * methods are instance-bound to that function's result?
 */
export function isFactoryReturnedLiteral(object: AstNode): boolean {
  return factoryName(object) !== null;
}

/**
 * The factory scope the chunker must add for `member`, strictly below
 * `container` (the node whose name the caller already composed; null = walk to
 * the root): `[name]` when `member` sits in the literal a DECLARATOR-bound
 * function returns, `[]` otherwise.
 *
 * A declarator-bound factory (`const make = () => ({ m() {} })`) is never a
 * chunk container, so without this the chunker composed `m` under whatever
 * encloses the declaration — a bare `m` at module level, `Store#build#m` inside
 * a method — while the walker names the declarator and composes `make#m` /
 * `Store#build.make#m`. A `function_declaration` or `method_definition` factory
 * IS the container its members are extracted from, so it is already composed
 * and contributes nothing here. The declarator's segment joins with the
 * language scope separator, exactly as the walker joins it.
 */
export function enclosingFactoryScopeNames(member: AstNode, container: AstNode | null): string[] {
  if (member.type !== "method_definition" || member.parent === null) return [];
  const returning = returningFunction(member.parent);
  if (returning === null || returning.type === "function_declaration" || returning.type === "method_definition") {
    return [];
  }
  const name = functionName(returning);
  if (name === null) return [];
  for (let p: AstNode | null = member.parent; p !== null && p !== container; p = p.parent) {
    if (p === returning) return [name];
  }
  return [];
}

/** The returning function's name when `object` is its returned literal, else null. */
function factoryName(object: AstNode): string | null {
  const returning = returningFunction(object);
  return returning === null ? null : functionName(returning);
}

/** The function whose value `object` is — returned or an arrow's expression body — else null. */
function returningFunction(object: AstNode): AstNode | null {
  if (object.type !== "object") return null;
  let valueParent = object.parent;
  while (valueParent !== null && VALUE_WRAPPER_TYPES.has(valueParent.type)) valueParent = valueParent.parent;
  if (valueParent === null) return null;
  // An `object` that is a direct child of an arrow is its expression body — a
  // default parameter value sits under `formal_parameters`, never here.
  if (valueParent.type === "arrow_function") return valueParent;
  if (valueParent.type !== "return_statement") return null;
  return nearestFunction(valueParent);
}

function nearestFunction(node: AstNode): AstNode | null {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (FUNCTION_TYPES.has(ancestor.type)) return ancestor;
  }
  return null;
}

/** The name the walker gives this function — the segment the member composes under — or null. */
function functionName(fn: AstNode): string | null {
  if (fn.type === "function_declaration" || fn.type === "method_definition") {
    return fn.childForFieldName("name")?.text ?? null;
  }
  const binding = fn.parent;
  return binding === null ? null : functionValuedDeclaratorName(binding);
}
