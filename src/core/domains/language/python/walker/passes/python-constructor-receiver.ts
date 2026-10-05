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
 *     `items[0].Client`) — a computed value.
 *
 * Everything else — a bare name, a dotted name rooted at one, `self.Upper` —
 * reads exactly as before: the predicate only ever REMOVES an answer, and only
 * one no project module or class could have given.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pythonBoundParamNames } from "./python-def-signatures.js";

/** Node types whose `parameters` bind names visible to the body. */
const PYTHON_PARAMETER_SCOPES: ReadonlySet<string> = new Set(["function_definition", "lambda"]);

/** The receiver spellings a class-scoped def binds. */
const PYTHON_RECEIVER_NAMES: ReadonlySet<string> = new Set(["self", "cls"]);

/**
 * Is `fn` — the `function` field of a call — a dotted callee whose receiver is
 * a VALUE (see the module comment)? `false` for an identifier callee and for
 * every receiver that can name a module or class.
 */
export function pythonConstructorReceiverIsValue(fn: AstNode): boolean {
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
  return isEnclosingParameter(fn, root.text);
}

/** Does a def or lambda enclosing `node` bind `name` as a parameter? */
function isEnclosingParameter(node: AstNode, name: string): boolean {
  for (let scope = node.parent; scope !== null; scope = scope.parent) {
    if (PYTHON_PARAMETER_SCOPES.has(scope.type) && pythonBoundParamNames(scope).includes(name)) return true;
  }
  return false;
}
