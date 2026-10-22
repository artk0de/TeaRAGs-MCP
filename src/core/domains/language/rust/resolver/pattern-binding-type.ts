/**
 * The type of a Rust pattern-bound name (bd tea-rags-mcp-s3i8m, Task 1a): the
 * scrutinee's type folded through the binding's `projection`. Both typing
 * ports read it BEFORE any other channel — a pattern binding shadows the name,
 * so it never falls through to a call-result binding or an outer binding of
 * the same name. A step this fold cannot prove answers `undefined`: the name
 * is untyped.
 *
 * Folded steps: `Some` / `Ok` → argument 0 and `Err` → argument 1 of a std
 * `Option` / `Result`, `tuple` → the element, `field` → the placed struct's
 * declared field. A project enum variant's payload, a loop element and a
 * closure adapter parameter are not folded yet.
 */

import type { CallContext, LocalBinding, PatternStep } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { rustFreeCallResultType } from "./declared-call-result-type.js";
import { rustDeclaredFieldType } from "./declared-field-type.js";

/** Types an expression read at a source position — the chain fold the strategy layer owns. */
export type RustExpressionTyper = (
  expression: string,
  atLine: number,
  ctx: CallContext,
  atColumn?: number,
) => TypeRef | undefined;

/** The std enum each prelude variant constructor belongs to, and the argument its payload is. */
const RUST_STD_VARIANT_PAYLOADS: ReadonlyMap<string, { readonly owner: string; readonly argument: number }> = new Map([
  ["Some", { owner: "Option", argument: 0 }],
  ["Ok", { owner: "Result", argument: 0 }],
  ["Err", { owner: "Result", argument: 1 }],
]);
const RUST_BARE_CALL = /^([A-Za-z_][A-Za-z0-9_]*)\((.*)\)$/s;

/** Bindings whose fold is in progress — a scrutinee that reads a binding back to itself declines. */
const foldsInProgress = new Set<LocalBinding>();

export function rustPatternBindingType(
  binding: LocalBinding,
  ctx: CallContext,
  typeExpression: RustExpressionTyper,
): TypeRef | undefined {
  const { projection, sourceExpression } = binding;
  if (projection === undefined || sourceExpression === undefined || foldsInProgress.has(binding)) return undefined;
  foldsInProgress.add(binding);
  try {
    let current = rustScrutineeType(binding, sourceExpression, ctx, typeExpression);
    for (const step of projection) {
      if (current === undefined) return undefined;
      current = rustPatternStepType(current, step, ctx);
    }
    return current;
  } finally {
    foldsInProgress.delete(binding);
  }
}

/** The scrutinee, read where it is written: a bare free-function call by its declared return, else the chain fold. */
function rustScrutineeType(
  binding: LocalBinding,
  sourceExpression: string,
  ctx: CallContext,
  typeExpression: RustExpressionTyper,
): TypeRef | undefined {
  const expression = sourceExpression.replace(/\s+/g, "");
  const bareCall = RUST_BARE_CALL.exec(expression);
  if (bareCall !== null && closesAtEnd(expression, bareCall[1].length)) {
    return rustFreeCallResultType(bareCall[1], ctx);
  }
  const span = binding.conditionSpan;
  return typeExpression(expression, span?.startLine ?? binding.line, ctx, span?.startColumn);
}

/** Whether the `(` at `open` closes at the expression's last character — `f(a)(b)` is not one call. */
function closesAtEnd(expression: string, open: number): boolean {
  let depth = 0;
  for (let i = open; i < expression.length; i++) {
    if (expression[i] === "(") depth++;
    else if (expression[i] === ")" && --depth === 0) return i === expression.length - 1;
  }
  return false;
}

function rustPatternStepType(recv: TypeRef, step: PatternStep, ctx: CallContext): TypeRef | undefined {
  switch (step.kind) {
    case "variant":
      return "index" in step ? rustStdVariantPayload(recv, step.path, step.index) : undefined;
    case "tuple":
      return recv.form === "tuple" ? recv.elements[step.index] : undefined;
    case "field":
      return rustDeclaredFieldType(recv, step.name, ctx);
    case "element":
    case "adapterParam":
      return undefined;
  }
}

/** `Some(x)` / `Ok(x)` / `Err(e)` on a std `Option` / `Result`: the payload argument. */
function rustStdVariantPayload(recv: TypeRef, path: string, index: number): TypeRef | undefined {
  const segments = path.split("::");
  const variant = RUST_STD_VARIANT_PAYLOADS.get(segments.at(-1) ?? "");
  if (variant === undefined || index !== 0) return undefined;
  if (segments.length > 1 && segments.at(-2) !== variant.owner) return undefined;
  if (recv.form !== "instance" || recv.name.includes(".rs::")) return undefined;
  if (recv.name !== variant.owner && !recv.name.endsWith(`::${variant.owner}`)) return undefined;
  return recv.args?.[variant.argument];
}
