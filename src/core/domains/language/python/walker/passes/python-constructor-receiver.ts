/**
 * Can the RECEIVER of a dotted constructor spelling name a class at all (bd
 * tea-rags-mcp-m99j1.1.85)?
 *
 * `<recv>.<Upper>(…)` is read as "construct the class `<Upper>` that `<recv>`
 * declares", and every reader of the spelling strips it to its last segment and
 * places that by short name. That reading is sound only when `<recv>` is a NAME
 * a module or class is bound by — an import binding or module alias (`mod`), a
 * class attribute (`self.Inner`, `cls.Inner`) — because the class it names is
 * then one the project can declare. A receiver that is a VALUE names nothing:
 * django's memcached backend stores an injected module (`self._lib = library`)
 * and calls `self._lib.Client(…)`, and the short-name read typed the result as
 * whatever project class happens to be called `Client`.
 *
 * Decided syntactically, per file, as a VALUE:
 *
 *   - an attribute OF an attribute of `self` / `cls` (`self._lib.Client`) —
 *     the instance's field holds a value whose type this walk does not know;
 *   - a receiver rooted at a PARAMETER of an enclosing def or lambda
 *     (`library.Client`) — an argument is a value, an injected module included;
 *   - a receiver that is not a dotted name at all (`make().Client`,
 *     `items[0].Client`) — a computed value;
 *   - a receiver rooted at a LOCAL of an enclosing def every binding of which
 *     assigns a value (bd tea-rags-mcp-m99j1.1.88): `lib = load()`,
 *     `engine = import_module(settings.SESSION_ENGINE)`, `x = getattr(…)`,
 *     `w = None` — the local holds whatever that value is at run time.
 *
 * A BARE callee is the same question one level down (bd
 * tea-rags-mcp-m99j1.1.90): `DatabaseWrapper = type(self.connection);
 * DatabaseWrapper(…)` or a test's `FormSet = formset_factory(…); FormSet(…)`
 * calls a def-LOCAL, and LEGB makes that local shadow every class of the same
 * short name. Such a callee is a value when every binding of it in the nearest
 * binding def assigns a value — EXCEPT a call on `self` / `cls`
 * (`ModelForm = self.get_form(…)`): that is the class-hook idiom, whose result
 * is the namesake or a subclass of it, and it reads as before. Measured on six
 * corpora: every resolved row the hook shape produced was correct, every one
 * the other shapes produced was fabricated (`type(…)`, a migration's
 * `apps.get_model(…)` historical model, which carries none of the project
 * class's methods).
 *
 * Everything else — a bare name, a dotted name rooted at one, `self.Upper`, a
 * local aliasing a name (`lib = mod`), an `import … as lib` inside the def, an
 * annotated local, a local with any binding other than a plain value
 * assignment — reads exactly as before: the predicate only ever REMOVES an
 * answer, and only one no project module or class could have given.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pythonBoundParamNames } from "./python-def-signatures.js";

/** Node types whose `parameters` bind names visible to the body. */
const PYTHON_PARAMETER_SCOPES: ReadonlySet<string> = new Set(["function_definition", "lambda"]);

/** The receiver spellings a class-scoped def binds. */
const PYTHON_RECEIVER_NAMES: ReadonlySet<string> = new Set(["self", "cls"]);

/**
 * Is `fn` — the `function` field of a call — a callee that names no class: a
 * dotted callee whose receiver is a VALUE, or a bare CapWords callee that is a
 * value-bound def-local (see the module comment)? `false` for every callee that
 * can name a module or class.
 */
export function pythonConstructorReceiverIsValue(fn: AstNode): boolean {
  if (fn.type === "identifier") {
    return PYTHON_CONSTRUCTOR_SEGMENT.test(fn.text) && isValueBoundLocal(fn, fn.text, isNonHookValueRhs);
  }
  if (fn.type !== "attribute") return false;
  const receiver = fn.childForFieldName("object");
  if (receiver === null) return false;
  let root = receiver;
  let hops = 0;
  while (root.type === "attribute") {
    const object = root.childForFieldName("object");
    if (object === null) return true;
    root = object;
    hops++;
  }
  if (root.type !== "identifier") return true;
  if (PYTHON_RECEIVER_NAMES.has(root.text)) return hops > 0;
  if (isEnclosingParameter(fn, root.text)) return true;
  // Every caller reads the result only for a CapWords last segment, so a
  // lowercase callee (`json.loads`) never pays for the def-body scan below.
  const attr = fn.childForFieldName("attribute");
  return attr !== null && PYTHON_CONSTRUCTOR_SEGMENT.test(attr.text) && isValueBoundLocal(fn, root.text, isValueRhs);
}

/** A last segment any constructor channel may read as a class (`Client`, `_Inner`). */
const PYTHON_CONSTRUCTOR_SEGMENT = /^_*[A-Z]/;

/**
 * Right-hand sides that bind a VALUE: a call result, an awaited result, an
 * item of a container, `None`. A name or a dotted name (`lib = mod`) may alias
 * a module or class, and a conditional or boolean may evaluate to one, so those
 * keep the receiver a name.
 */
const PYTHON_VALUE_RHS_TYPES: ReadonlySet<string> = new Set(["call", "await", "subscript", "none"]);

/** Scopes whose bindings are their own: a nested def, class or lambda. */
const PYTHON_NESTED_SCOPES: ReadonlySet<string> = new Set(["function_definition", "class_definition", "lambda"]);

/** How a def binds a name: not at all, only by value assignments, or any other way. */
type PythonLocalBindingVerdict = "unbound" | "value" | "name";

/**
 * Is `name` a local of the nearest enclosing def that binds it, bound there
 * ONLY by value assignments? A def that does not bind it is skipped (a closure
 * reads the enclosing def's local); a class body is never consulted, because
 * a method does not see class-body names.
 */
function isValueBoundLocal(node: AstNode, name: string, valueRhs: PythonValueRhsTest): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (scope.type !== "function_definition") continue;
    const verdict = pythonLocalBindingVerdict(scope, name, valueRhs);
    if (verdict !== "unbound") return verdict === "value";
  }
  return false;
}

/** {@link PythonLocalBindingVerdict} of `name` over the body of `def`, nested scopes excluded. */
function pythonLocalBindingVerdict(
  def: AstNode,
  name: string,
  valueRhs: PythonValueRhsTest,
): PythonLocalBindingVerdict {
  const body = def.childForFieldName("body");
  if (body === null) return "unbound";
  let verdict: PythonLocalBindingVerdict = "unbound";
  const pending: AstNode[] = [body];
  while (pending.length > 0) {
    const node = pending.pop() as AstNode;
    if (PYTHON_NESTED_SCOPES.has(node.type)) {
      // The nested scope's NAME binds in this def; its body binds in its own.
      if (node.childForFieldName("name")?.text === name) return "name";
      continue;
    }
    const binding = pythonBindingKind(node, name, valueRhs);
    if (binding === "name") return "name";
    if (binding === "value") verdict = "value";
    for (const child of node.namedChildren) pending.push(child);
  }
  return verdict;
}

/** How the single node `node` binds `name`, if it is a binding construct at all. */
function pythonBindingKind(node: AstNode, name: string, valueRhs: PythonValueRhsTest): PythonLocalBindingVerdict {
  switch (node.type) {
    case "assignment": {
      const left = node.childForFieldName("left");
      if (left === null) return "unbound";
      if (left.type === "identifier") {
        if (left.text !== name) return "unbound";
        if (node.childForFieldName("type") !== null) return "name";
        return valueRhs(node.childForFieldName("right")) ? "value" : "name";
      }
      return bindsIdentifier(left, name) && left.type !== "attribute" && left.type !== "subscript" ? "name" : "unbound";
    }
    case "named_expression":
      if (node.childForFieldName("name")?.text !== name) return "unbound";
      return valueRhs(node.childForFieldName("value")) ? "value" : "name";
    case "augmented_assignment":
      return node.childForFieldName("left")?.text === name ? "name" : "unbound";
    case "for_statement":
    case "for_in_clause":
      return bindsIdentifier(node.childForFieldName("left"), name) ? "name" : "unbound";
    case "as_pattern":
      return bindsIdentifier(node.childForFieldName("alias"), name) ? "name" : "unbound";
    case "import_statement":
    case "import_from_statement":
    case "global_statement":
    case "nonlocal_statement":
      return bindsIdentifier(node, name) ? "name" : "unbound";
    default:
      return "unbound";
  }
}

/** Does `node`, or any node under it, spell the identifier `name`? */
function bindsIdentifier(node: AstNode | null, name: string): boolean {
  if (node === null) return false;
  if (node.type === "identifier") return node.text === name;
  return node.namedChildren.some((child) => bindsIdentifier(child, name));
}

/** Which right-hand sides of a local's binding count as a VALUE for one receiver shape. */
type PythonValueRhsTest = (rhs: AstNode | null) => boolean;

function isValueRhs(rhs: AstNode | null): boolean {
  return rhs !== null && PYTHON_VALUE_RHS_TYPES.has(rhs.type);
}

/**
 * {@link isValueRhs} for a BARE callee, minus the class-hook call on the
 * method's own receiver (`self.get_form(…)`, `cls.get_form_class()`): that
 * binding keeps the callee a name (see the module comment).
 */
function isNonHookValueRhs(rhs: AstNode | null): boolean {
  if (!isValueRhs(rhs)) return false;
  if (rhs?.type !== "call") return true;
  const fn = rhs.childForFieldName("function");
  const object = fn?.type === "attribute" ? fn.childForFieldName("object") : null;
  return object?.type !== "identifier" || !PYTHON_RECEIVER_NAMES.has(object.text);
}

/** Does a def or lambda enclosing `node` bind `name` as a parameter? */
function isEnclosingParameter(node: AstNode, name: string): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (PYTHON_PARAMETER_SCOPES.has(scope.type) && pythonBoundParamNames(scope).includes(name)) return true;
  }
  return false;
}
