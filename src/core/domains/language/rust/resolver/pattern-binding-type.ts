/**
 * The type of a Rust pattern-bound name (bd tea-rags-mcp-s3i8m, Task 1a): the
 * scrutinee's type folded through the binding's `projection`. Both typing
 * ports read it BEFORE any other channel — a pattern binding shadows the name,
 * so it never falls through to a call-result binding or an outer binding of
 * the same name. A step this fold cannot prove answers `undefined`: the name
 * is untyped.
 *
 * Folded steps: `Some` / `Ok` → argument 0 and `Err` → argument 1 of a std
 * `Option` / `Result`, a project enum variant → its declared payload field,
 * `tuple` → the element, `field` → the placed struct's declared field. A
 * loop element and a closure adapter parameter (Task 1b) read the std
 * collection / iterator / combinator tables in `std-type-hops`.
 */

import type { CallContext, LocalBinding, PatternStep } from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import { splitAtBracketDepthZero } from "../../kernel/index.js";
import { rustFreeCallResultType } from "./declared-call-result-type.js";
import { rustDeclaredFieldType, rustDeclaredVariantFieldType } from "./declared-field-type.js";
import { rustExternalFreeCallType } from "./external-type-hops.js";
import {
  RUST_ITERATOR_CHAIN_MEMBERS,
  rustStdClosureParamType,
  rustStdElementType,
  rustStdUnwrapType,
} from "./std-type-hops.js";

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
/** A free-function callee, module-qualified or bare, with an optional turbofish: the spelling. */
const RUST_FREE_CALLEE = /^((?:::)?(?:[a-z_]\w*::)*[a-z_]\w*)(?:::<[^()]*>)?\(/;
/** An unwrapping tail hop: `unwrap()` or `expect(..)`. */
const RUST_UNWRAP_HOP = /^(?:unwrap\(\)|expect\(.*\))$/s;
/** One method-call hop, `name(…)` — the member name. */
const RUST_ARGUMENT_CALL = /^([A-Za-z_][A-Za-z0-9_]*)\(.*\)$/s;

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
    // A loop element or an adapter's closure parameter is always the first
    // step: its source is an iterable, read through the iterator chain.
    const [firstStep, ...rest] = projection;
    const iterated = firstStep?.kind === "element" || firstStep?.kind === "adapterParam";
    let current = iterated
      ? rustIteratedStepType(binding, sourceExpression, firstStep, ctx, typeExpression)
      : rustScrutineeType(binding, sourceExpression, ctx, typeExpression);
    for (const step of iterated ? rest : projection) {
      if (current === undefined) return undefined;
      current = rustPatternStepType(current, step, ctx);
    }
    return current;
  } finally {
    foldsInProgress.delete(binding);
  }
}

/**
 * The scrutinee, read where it is written: a bare free-function call by its
 * declared return (the project's, else the external table's), else the chain
 * fold, else a free-function call under unwrapping tails.
 */
function rustScrutineeType(
  binding: LocalBinding,
  sourceExpression: string,
  ctx: CallContext,
  typeExpression: RustExpressionTyper,
): TypeRef | undefined {
  const expression = rustWithoutBorrow(sourceExpression);
  const bareCall = RUST_BARE_CALL.exec(expression);
  if (bareCall !== null && closesAtEnd(expression, bareCall[1].length)) {
    return rustFreeCallResultType(bareCall[1], ctx) ?? rustExternalFreeCallType(bareCall[1], ctx);
  }
  const span = binding.conditionSpan;
  return (
    typeExpression(expression, span?.startLine ?? binding.line, ctx, span?.startColumn) ??
    rustUnwrappedFreeCallType(expression, ctx)
  );
}

/**
 * `channel()?`, `ipc::channel().unwrap()`, `mpsc::sync_channel(1)` (bd
 * s3i8m.7 T-A2): the trailing `?` / `.unwrap()` / `.expect(..)` hops are
 * peeled, the free-function call left is typed (a bare name by the project
 * first), and each peeled hop unwraps the std `Option` / `Result` once.
 */
function rustUnwrappedFreeCallType(expression: string, ctx: CallContext): TypeRef | undefined {
  const hops = splitAtBracketDepthZero(expression, ".");
  let unwraps = 0;
  for (;;) {
    const last = hops[hops.length - 1];
    if (last.endsWith("?")) {
      hops[hops.length - 1] = last.slice(0, -1);
    } else if (hops.length > 1 && RUST_UNWRAP_HOP.test(last) && closesAtEnd(last, last.indexOf("("))) {
      hops.pop();
    } else {
      break;
    }
    unwraps++;
  }
  if (hops.length !== 1) return undefined;
  const call = hops[0];
  const callee = RUST_FREE_CALLEE.exec(call);
  if (callee === null || !closesAtEnd(call, callee[0].length - 1)) return undefined;
  const spelling = callee[1];
  let produced =
    (spelling.includes("::") ? undefined : rustFreeCallResultType(spelling, ctx)) ??
    rustExternalFreeCallType(spelling, ctx);
  for (let i = 0; i < unwraps && produced !== undefined; i++) produced = rustStdUnwrapType(produced, "?");
  return produced;
}

/** The expression without whitespace and without a leading borrow or deref (`&mut v`, `*self`) — both are transparent to a pattern. */
function rustWithoutBorrow(expression: string): string {
  return expression
    .trim()
    .replace(/^(?:&\s*(?:mut\s+)?|\*)+/, "")
    .replace(/\s+/g, "");
}

/**
 * A loop element (`for p in self.peers.iter()`) or an adapter closure's
 * parameter (`v.iter().map(|p| …)`, `opt.map(|p| …)`): the trailing iterator
 * chain members are peeled off the source, the rest is typed like any
 * scrutinee, and the std tables answer the item.
 */
function rustIteratedStepType(
  binding: LocalBinding,
  sourceExpression: string,
  step: PatternStep,
  ctx: CallContext,
  typeExpression: RustExpressionTyper,
): TypeRef | undefined {
  const hops = splitAtBracketDepthZero(rustWithoutBorrow(sourceExpression), ".");
  const adapters: string[] = [];
  while (hops.length > 1) {
    const member = RUST_ARGUMENT_CALL.exec(hops[hops.length - 1])?.[1];
    if (member === undefined || !RUST_ITERATOR_CHAIN_MEMBERS.has(member)) break;
    adapters.unshift(member);
    hops.pop();
  }
  const iterableType = rustScrutineeType(binding, hops.join("."), ctx, typeExpression);
  if (iterableType === undefined) return undefined;
  if (step.kind === "element") return rustStdElementType(iterableType, adapters);
  if (step.kind !== "adapterParam") return undefined;
  const item = adapters.length > 0 ? rustStdElementType(iterableType, adapters) : undefined;
  if (adapters.length > 0 && item === undefined) return undefined;
  return rustStdClosureParamType(iterableType, item, step.adapter, step.argument, step.index);
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
      return recv.form === "instance" && recv.name.includes(".rs::")
        ? rustProjectVariantPayload(recv, step, ctx)
        : "index" in step
          ? rustStdVariantPayload(recv, step.path, step.index)
          : undefined;
    case "tuple":
      return recv.form === "tuple" ? recv.elements[step.index] : undefined;
    case "field":
      return rustDeclaredFieldType(recv, step.name, ctx);
    case "element":
    case "adapterParam":
      // Only ever a binding's first step, folded off its iterable source.
      return undefined;
  }
}

/**
 * `Enum::A(w)` / `Self::B { peer }` / `A(w)` on the placed project enum
 * `recv`: the variant's declared payload field, generics substituted from
 * `recv`'s arguments. A qualifier naming another type declines — the arm
 * cannot match a value of `recv`'s type.
 */
function rustProjectVariantPayload(
  recv: TypeRef,
  step: Extract<PatternStep, { kind: "variant" }>,
  ctx: CallContext,
): TypeRef | undefined {
  if (recv.form !== "instance") return undefined;
  const segments = step.path.split("::");
  const variant = segments[segments.length - 1];
  const qualifier = segments.at(-2);
  if (qualifier !== undefined && qualifier !== "Self" && qualifier !== recv.name.split("::").at(-1)) return undefined;
  return rustDeclaredVariantFieldType(recv, variant, "index" in step ? String(step.index) : step.field, ctx);
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
