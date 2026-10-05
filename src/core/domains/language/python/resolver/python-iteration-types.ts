/**
 * Python iteration typing (P1, bd tea-rags-mcp-m99j1.1.18) — what a loop or
 * comprehension target denotes, folded from the ITERATED expression the walker
 * recorded on an `iterationElement` binding.
 *
 * Two halves:
 *
 *   - the built-in table, read off the expression's SPELLING: `d.values()`,
 *     `d.items()` (value at position 1), `enumerate(xs)` (element at position
 *     1), `zip(a, b)` (the i-th argument's element at position i), and the
 *     element-preserving wrappers `list` / `set` / `frozenset` / `tuple` /
 *     `reversed` / `sorted` / `iter`;
 *   - {@link pythonElementTypeOf}, the kernel `elementTypeOf` port: a
 *     container's element, a homogeneous tuple's, or a PROJECT class's own
 *     `__iter__` → `__next__` read through the member-return walk.
 *
 * Never invents a type. The container's type comes from facts the run already
 * carries — a local's container annotation, a member's or a callee's recorded
 * return — and an expression no fact types yields nothing. Known blind spot,
 * accepted: the annotation parser renders `dict[K, V]` as `container(V)`, the
 * same form `list[V]` takes, so a BARE iteration over a mapping-typed value
 * reads `V` where Python yields `K`. `.values()` / `.items()` are the
 * mapping reads and are exact; `.keys()` is declined (the key slot is gone).
 */

import {
  nearestCallResultBinding,
  resolveLocalBinding,
  type CallContext,
  type LocalBinding,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  callArgumentText,
  propagateReceiverType,
  splitAtBracketDepthZero,
  splitReceiverHops,
  typeRefReceiverForm,
  typeRefTupleElement,
  type ReceiverTypePorts,
} from "../../kernel/index.js";
import type { PythonImportFileMapper } from "./python-import-file-mapper.js";
import { pythonCallBindingType } from "./python-member-return-types.js";
import { findPythonImportBinding } from "./python-type-addressing.js";

/** Built-ins whose iteration yields their first argument's elements unchanged. */
const PYTHON_ELEMENT_PRESERVING_BUILTINS = new Set(["list", "set", "frozenset", "tuple", "reversed", "sorted", "iter"]);

/** A local name — the only iterable spelling read through the binding channels directly. */
const PYTHON_LOCAL_NAME = /^[A-Za-z_]\w*$/;

/** A built-in call spelled `name(args)`. */
const PYTHON_BUILTIN_CALL_HEAD = /^([a-z_]+)\(/;

/** The mapping views, read off the last hop of the iterated expression. */
const PYTHON_MAPPING_VIEW = /^(values|items|keys)\(\)$/;

/**
 * The binding a name carries at `atLine` once iteration bindings are
 * accounted for — {@link resolveLocalBinding} for every other binding.
 *
 * One correction, reachable only when the nearest binding is an
 * `iterationElement` (a typed binding on the same line already outranks it in
 * the shared lookup): a call-result binding established AFTER the loop
 * rebinds the name, and the iteration binding stops speaking for it
 * (`undefined`, so the caller reads the call-result channel as it would with
 * no binding).
 */
export function pythonLocalBindingInForce(ctx: CallContext, name: string, atLine: number): LocalBinding | undefined {
  const best = resolveLocalBinding(ctx.localBindings, name, atLine);
  if (best?.valueKind !== "iterationElement") return best;
  const rebound = nearestCallResultBinding(ctx.callResultBindings, name, atLine);
  return rebound !== undefined && rebound.line > best.line ? undefined : best;
}

/**
 * The kernel `elementTypeOf` port: what iterating a value of type `container`
 * yields, or `null`. `memberTypeOf` is the run's member-return read — the
 * kernel `MemberReturnTypeResolver` walk — through which a project class's
 * `__iter__` and its iterator's `__next__` are read.
 */
export function pythonElementTypeOf(
  container: TypeRef,
  ctx: CallContext,
  memberTypeOf: (recv: TypeRef, member: string, ctx: CallContext) => TypeRef | undefined,
): TypeRef | null {
  if (container.form === "container") return container.element;
  if (container.form === "tuple") return homogeneousTupleElement(container.elements);
  if (container.form !== "instance") return null;
  const iterator = memberTypeOf(container, "__iter__", ctx);
  if (iterator === undefined) return null;
  if (iterator.form === "container") return iterator.element;
  if (iterator.form !== "instance") return null;
  return memberTypeOf(iterator, "__next__", ctx) ?? null;
}

/** `tuple[A, A]` iterates as `A`; a heterogeneous tuple has no single element type. */
function homogeneousTupleElement(elements: readonly TypeRef[]): TypeRef | null {
  const [first] = elements;
  if (first === undefined || (first.form !== "instance" && first.form !== "class")) return null;
  return elements.every((element) => element.form === first.form && element.name === first.name) ? first : null;
}

/**
 * The receiver-form type an `iterationElement` binding denotes, or
 * `undefined`. `ports` must be the run's Python ports (they carry
 * `elementTypeOf`); `mapper` folds a call-result binding the iterable names.
 */
export function pythonIterationElementType(
  binding: LocalBinding,
  ctx: CallContext,
  ports: ReceiverTypePorts,
  mapper: PythonImportFileMapper,
): TypeRef | undefined {
  const expression = binding.sourceExpression;
  if (expression === undefined) return undefined;
  // The iterable is evaluated BEFORE the target is bound, and on the line
  // above it nothing the loop binds is visible — which is also what makes
  // every nested read strictly earlier, so the fold terminates.
  const reader: PythonIterableReader = { atLine: binding.line - 1, ctx, ports, mapper };
  return typeRefReceiverForm(iteratedElement(expression, binding.tupleIndex, reader));
}

interface PythonIterableReader {
  readonly atLine: number;
  readonly ctx: CallContext;
  readonly ports: ReceiverTypePorts;
  readonly mapper: PythonImportFileMapper;
}

/** The element `expression` yields at `tupleIndex` (the whole element when absent). */
function iteratedElement(
  expression: string,
  tupleIndex: number | undefined,
  reader: PythonIterableReader,
): TypeRef | undefined {
  const builtin = builtinCall(expression, reader);
  if (builtin !== null) return builtinElement(builtin, tupleIndex, reader);
  const hops = splitReceiverHops(expression);
  const view = hops.length > 1 ? PYTHON_MAPPING_VIEW.exec(hops[hops.length - 1]) : null;
  if (view !== null) {
    const mapping = typeOfIterable(hops.slice(0, -1).join("."), reader);
    if (mapping?.form !== "container") return undefined;
    if (view[1] === "values") return atPosition(mapping.element, tupleIndex);
    return view[1] === "items" && tupleIndex === 1 ? mapping.element : undefined;
  }
  const iterable = typeOfIterable(expression, reader);
  const element = iterable === undefined ? null : (reader.ports.elementTypeOf?.(iterable, reader.ctx) ?? null);
  return element === null ? undefined : atPosition(element, tupleIndex);
}

/** The element itself, or its `tupleIndex`-th position when the target destructures it. */
function atPosition(element: TypeRef, tupleIndex: number | undefined): TypeRef | undefined {
  if (tupleIndex === undefined) return element;
  return typeRefTupleElement(element, tupleIndex) ?? undefined;
}

/** A call to an UNSHADOWED built-in: `name` plus its positional arguments. */
function builtinCall(
  expression: string,
  reader: PythonIterableReader,
): { readonly name: string; readonly args: readonly string[] } | null {
  const head = PYTHON_BUILTIN_CALL_HEAD.exec(expression);
  if (head === null) return null;
  const name = head[1];
  if (name !== "enumerate" && name !== "zip" && !PYTHON_ELEMENT_PRESERVING_BUILTINS.has(name)) return null;
  const argumentText = callArgumentText(expression);
  // The call must span the whole expression: `sorted(xs).pop` is not a `sorted` iteration.
  if (argumentText === undefined || name.length + argumentText.length + 2 !== expression.length) return null;
  if (findPythonImportBinding(reader.ctx.imports, name) !== null) return null;
  if (resolveLocalBinding(reader.ctx.localBindings, name, reader.atLine) !== undefined) return null;
  const args = splitAtBracketDepthZero(argumentText, ",")
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0 && !arg.startsWith("*") && !/^\w+\s*=[^=]/.test(arg));
  return { name, args };
}

/** The built-in table: which argument, and which position, an iteration of the call yields. */
function builtinElement(
  builtin: { readonly name: string; readonly args: readonly string[] },
  tupleIndex: number | undefined,
  reader: PythonIterableReader,
): TypeRef | undefined {
  const { name, args } = builtin;
  // `enumerate` yields `(index, element)`; `zip` the i-th argument's element at
  // position i; every other entry passes the destructuring through.
  let source: string | undefined;
  let sourceIndex = tupleIndex;
  if (name === "enumerate") {
    source = tupleIndex === 1 ? args[0] : undefined;
    sourceIndex = undefined;
  } else if (name === "zip") {
    source = tupleIndex === undefined ? undefined : args[tupleIndex];
    sourceIndex = undefined;
  } else {
    source = args[0];
  }
  return source === undefined ? undefined : iteratedElement(source, sourceIndex, reader);
}

/**
 * The type of the ITERABLE, container forms kept. A bare local is read off the
 * binding channels directly — the fold's single-hop read keeps only a bound
 * type's NAME, and a container annotation lives in `typeRef` — taking whichever
 * of the walker's binding and a call-result binding is more recent. Everything
 * else goes through the shared receiver fold.
 */
function typeOfIterable(expression: string, reader: PythonIterableReader): TypeRef | undefined {
  const { atLine, ctx, ports, mapper } = reader;
  if (!PYTHON_LOCAL_NAME.test(expression)) return propagateReceiverType(expression, atLine, ctx, ports);
  const bound = pythonLocalBindingInForce(ctx, expression, atLine);
  const called = nearestCallResultBinding(ctx.callResultBindings, expression, atLine);
  if (called !== undefined && (bound === undefined || called.line > bound.line)) {
    return pythonCallBindingType(called.callee, called.line, ctx, ports, mapper);
  }
  if (bound === undefined) return propagateReceiverType(expression, atLine, ctx, ports);
  if (bound.valueKind === "iterationElement") return pythonIterationElementType(bound, ctx, ports, mapper);
  if (bound.type === "") return undefined;
  return bound.typeRef ?? { form: bound.valueKind === "class" ? "class" : "instance", name: bound.type };
}
