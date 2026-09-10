/**
 * Python type annotations → the kernel `TypeRef` algebra (E2 seam 2, bd
 * tea-rags-mcp-mt2q0 / 9fgdi).
 *
 * Two entry points over one rule table. `pythonTypeRefFromNode` walks an
 * annotation SUBTREE — that is the hot path, once per annotated parameter, and
 * it never touches the file's source text. `pythonTypeRefFromText` parses an
 * annotation STRING, which is what a `"Foo"` forward reference and every
 * docstring type actually is; it is a bounded recursive descent over one
 * annotation, not a scan of the file.
 *
 * The forms and their answers are the seam's decision 3. Three of them earn a
 * comment:
 *
 *   - `dict[K, V]` → `container(V)`. Subscripting a dict yields the VALUE, and
 *     the value is what a `d[k].method()` receiver is; keys are almost always
 *     `str` / `int` and name no in-project class. Every other mapping type
 *     follows the same last-argument rule.
 *   - A dotted annotation reduces to its LAST segment. The symbol table keys a
 *     top-level definition by its short name (`kernel/symbol-id.ts:22`), and
 *     every Python strategy already calls `lastSegment` before looking a bound
 *     type up (`python-local-binding.ts:78`).
 *   - An unknown generic base keeps the BASE as the receiver — `QuerySet[Foo]`
 *     is a `QuerySet`, and that is the honest reading of the annotation.
 *     Unwrapping a framework wrapper (SQLAlchemy `Mapped[Foo]`) is E3's job,
 *     driven by manifest-gated data rather than by a guess here.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import { NIL_TYPE_REF, typeRefReceiverForm, typeRefUnionOf } from "../../../kernel/type-ref.js";

/** Names that carry no receiver: annotated with one of these, a site gets no fact. */
export const PYTHON_DECLINED_TYPE_NAMES: ReadonlySet<string> = new Set([
  "Any",
  "AnyStr",
  "object",
  "NoReturn",
  "Never",
  "TypeVar",
  "Ellipsis",
  "Hashable",
  // Bare, un-subscripted forms of the constructors handled structurally below.
  "Optional",
  "Union",
  "Type",
  "Literal",
  "Callable",
  "Annotated",
  "ClassVar",
  "Final",
]);
/** Subscripted forms whose argument IS the answer — the wrapper is transparent. */
const PYTHON_TRANSPARENT_FIRST: ReadonlySet<string> = new Set([
  "ClassVar",
  "Final",
  "Annotated",
  "Awaitable",
  "Required",
  "NotRequired",
  "InitVar",
]);
/** `Coroutine[Send, Yield, Return]` — the LAST argument is the awaited value. */
const PYTHON_TRANSPARENT_LAST: ReadonlySet<string> = new Set(["Coroutine"]);
/**
 * Element type is the FIRST argument. Exported for the ITERATION direction,
 * which must name the container spelling outright: only a base listed HERE
 * yields its element to a `for`, and only one listed BELOW yields it to
 * `.values()` — every wrapper form in between (`Optional[...]`,
 * `Annotated[...]`) collapses to the same `container` ref from either side and
 * so is declined.
 */
export const PYTHON_CONTAINER_FIRST: ReadonlySet<string> = new Set([
  "list",
  "List",
  "set",
  "Set",
  "frozenset",
  "FrozenSet",
  "tuple",
  "Tuple",
  "deque",
  "Deque",
  "Sequence",
  "MutableSequence",
  "Iterable",
  "Iterator",
  "Generator",
  "AsyncIterable",
  "AsyncIterator",
  "AsyncGenerator",
  "Collection",
]);
/** Element type is the LAST argument — the mapping VALUE. Exported with its sibling above. */
export const PYTHON_CONTAINER_LAST: ReadonlySet<string> = new Set([
  "dict",
  "Dict",
  "Mapping",
  "MutableMapping",
  "OrderedDict",
  "defaultdict",
  "DefaultDict",
  "Counter",
]);
/** Subscripted forms that name no receiver at all. */
const PYTHON_OPAQUE_GENERICS: ReadonlySet<string> = new Set(["Callable", "Literal"]);

function isTypeRef(ref: TypeRef | undefined): ref is TypeRef {
  return ref !== undefined;
}

/** `pkg.mod.Foo` → `Foo`; `Foo` → `Foo`; `""` → `""`. */
export function pythonBareTypeName(text: string): string {
  const trimmed = text.trim();
  return trimmed.slice(trimmed.lastIndexOf(".") + 1);
}

function nominalTypeRef(text: string, selfClass: string | undefined): TypeRef | undefined {
  const bare = pythonBareTypeName(text);
  if (bare.length === 0) return undefined;
  // `None` is an ARM, never an absence — `Foo | None` must stay distinguishable
  // from `Foo` all the way to the consumer (`contracts/types/language.ts:660`).
  if (bare === "None" || bare === "NoneType") return NIL_TYPE_REF;
  if (bare === "Self") return selfClass === undefined ? undefined : { form: "instance", name: selfClass };
  if (PYTHON_DECLINED_TYPE_NAMES.has(bare)) return undefined;
  return { form: "instance", name: bare };
}

/** The one subscript rule table, shared by both entry points. */
function subscriptTypeRef(
  baseText: string,
  args: (TypeRef | undefined)[],
  selfClass: string | undefined,
): TypeRef | undefined {
  const base = pythonBareTypeName(baseText);
  const first = args[0];
  const last = args[args.length - 1];
  if (base === "Optional") return first === undefined ? undefined : typeRefUnionOf([first, NIL_TYPE_REF]);
  if (base === "Union") {
    const members = args.filter(isTypeRef);
    return members.length === 0 ? undefined : typeRefUnionOf(members);
  }
  if (base === "Type" || base === "type") {
    return first?.form === "instance" ? { form: "class", name: first.name } : undefined;
  }
  if (PYTHON_OPAQUE_GENERICS.has(base)) return undefined;
  if (PYTHON_TRANSPARENT_FIRST.has(base)) return first;
  if (PYTHON_TRANSPARENT_LAST.has(base)) return last;
  if (PYTHON_CONTAINER_FIRST.has(base)) return first === undefined ? undefined : { form: "container", element: first };
  if (PYTHON_CONTAINER_LAST.has(base)) return last === undefined ? undefined : { form: "container", element: last };
  // Unknown generic — the base class is the receiver.
  return nominalTypeRef(base, selfClass);
}

/** Split on `separator` at bracket depth 0, outside quotes. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Parse ONE annotation written as text: a forward reference, a docstring type,
 * or a test's table row. Bounded recursive descent over that string — never a
 * scan of the file.
 */
export function pythonTypeRefFromText(text: string, selfClass?: string): TypeRef | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : null;
  // Strip only a WHOLE-string literal. `"A" | "B"` also starts and ends with a
  // quote, and stripping there would corrupt both arms — so require that the
  // opening quote's partner is the final character.
  if (quote !== null && trimmed.length >= 2 && trimmed.indexOf(quote, 1) === trimmed.length - 1) {
    return pythonTypeRefFromText(trimmed.slice(1, -1), selfClass);
  }
  const arms = splitTopLevel(trimmed, "|");
  if (arms.length > 1) {
    const members = arms.map((arm) => pythonTypeRefFromText(arm, selfClass)).filter(isTypeRef);
    return members.length === 0 ? undefined : typeRefUnionOf(members);
  }
  const open = trimmed.indexOf("[");
  if (open > 0 && trimmed.endsWith("]")) {
    const args = splitTopLevel(trimmed.slice(open + 1, -1), ",").map((arg) => pythonTypeRefFromText(arg, selfClass));
    return subscriptTypeRef(trimmed.slice(0, open), args, selfClass);
  }
  return nominalTypeRef(trimmed, selfClass);
}

/**
 * Parse an annotation SUBTREE. `selfClass` is the enclosing class's short name,
 * supplied so `Self` resolves; undefined at module level, where `Self` is not
 * legal anyway.
 */
export function pythonTypeRefFromNode(node: AstNode, selfClass?: string): TypeRef | undefined {
  switch (node.type) {
    case "type":
    case "type_parameter": {
      const inner = node.namedChild(0);
      return inner === null ? undefined : pythonTypeRefFromNode(inner, selfClass);
    }
    case "identifier":
    case "dotted_name":
    case "attribute":
      return nominalTypeRef(node.text, selfClass);
    case "none":
      return NIL_TYPE_REF;
    // A forward reference is an annotation that happens to be spelled as a
    // string literal; `node.text` keeps its quotes and the text parser strips them.
    case "string":
      return pythonTypeRefFromText(node.text, selfClass);
    case "binary_operator": {
      if (node.childForFieldName("operator")?.text !== "|") return undefined;
      const members = [node.childForFieldName("left"), node.childForFieldName("right")]
        .map((side) => (side === null ? undefined : pythonTypeRefFromNode(side, selfClass)))
        .filter(isTypeRef);
      return members.length === 0 ? undefined : typeRefUnionOf(members);
    }
    case "subscript":
    case "generic_type": {
      const value = node.childForFieldName("value") ?? node.namedChild(0);
      if (value === null) return undefined;
      // `childForFieldName` yields the FIRST match only, and a subscript carries
      // one `subscript` field per argument — so read the arguments positionally.
      const rest = node.namedChildren.slice(1);
      const argNodes = rest.length === 1 && rest[0].type === "type_parameter" ? [...rest[0].namedChildren] : rest;
      return subscriptTypeRef(
        value.text,
        argNodes.map((arg) => pythonTypeRefFromNode(arg, selfClass)),
        selfClass,
      );
    }
    default:
      return undefined;
  }
}

/**
 * Decision 4's gate in ONE place: the class name when this ref has exactly one
 * reachable arm, `undefined` otherwise. A `param` / `local` / `ivar` fact is
 * emitted only when this answers — `LocalBinding.type` and `classFieldTypes`
 * are bare strings, and a container flattens to its element while a two-arm
 * union flattens to its first member, both of which name a receiver the call
 * site does not have.
 *
 * The GATE is not the VALUE: `param` / `local` facts keep the original ref so
 * `LocalBinding.typeRef` still carries the union for the dispatch engine.
 */
export function pythonNominalReceiverName(ref: TypeRef): string | undefined {
  const receiver = typeRefReceiverForm(ref);
  if (receiver === undefined) return undefined;
  return receiver.form === "class" || receiver.form === "instance" ? receiver.name : undefined;
}
