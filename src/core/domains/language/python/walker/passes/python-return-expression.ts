/**
 * The Python half of the kernel's return-inference ports (E2 seam 5, bd
 * tea-rags-mcp-9fgdi): which expression shapes name a class, and nothing else.
 *
 * The shapes, each one measured on the corpora rather than imagined:
 *   `Widget()`         a constructor call              → Widget
 *   `self`             a fluent method                 → the enclosing class
 *   `cls` / `cls(…)`   a `@classmethod` factory        → the enclosing class
 *   `self.session`     a field the class types         → that field's class
 *   `make()`           a SAME-FILE def                 → its return
 *   `self.m()`         a method of the enclosing class → its return
 *   `copy.copy(self)`  a shallow / deep self copy      → the `Self` marker
 *
 * The scope answers the three lookups (field, sibling method, same-file def)
 * as functions, because a lookup may itself need an inference: `cursor` returns
 * `self._cursor()`, whose own return is unannotated. The owner of the scope
 * runs that recursion as a cycle-guarded fixpoint (bd tea-rags-mcp-m99j1.1.36).
 * Same-file only on purpose: a per-file walker pass has no return types for
 * another file's defs, and `localCallBindings` does that hop at resolve time.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { PYTHON_SELF_RETURN, pythonBareTypeName } from "./python-type-annotation.js";

/** What the enclosing def can see: its class, and three lookups the scope's owner answers. */
export interface PythonReturnScope {
  /** Enclosing class short name; undefined at module level (`self` / `cls` are then meaningless). */
  readonly selfClass: string | undefined;
  /** The class a `self.<field>` read names, or null. */
  readonly fieldType: (field: string) => string | null;
  /** What `self.<m>(…)` / `cls.<m>(…)` returns when the enclosing class defines `m`, or null. */
  readonly selfMethodReturn: (method: string) => string | null;
  /** What a same-file top-level def `<name>(…)` returns, or null. */
  readonly fileReturn: (name: string) => string | null;
}

/** A single capitalized identifier — Python's class-name convention. */
const PYTHON_CLASS_NAME = /^[A-Z]\w*$/;

/** The `copy` module's two spellings of "an object of the same class as the argument". */
const PYTHON_SELF_COPY_CALLEES: ReadonlySet<string> = new Set(["copy.copy", "copy.deepcopy"]);

/** `self` / `cls` — the receiver spellings a class-scoped def binds. */
function isReceiverIdentifier(node: AstNode | null): boolean {
  return node?.type === "identifier" && (node.text === "self" || node.text === "cls");
}

/** `copy.copy(self)`: the copy has the RECEIVER's class, which only the reader knows. */
function isSelfCopy(call: AstNode, fn: AstNode): boolean {
  if (!PYTHON_SELF_COPY_CALLEES.has(fn.text)) return false;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  return args.length === 1 && args[0]?.type === "identifier" && args[0].text === "self";
}

export function pythonReturnExpressionType(node: AstNode, scope: PythonReturnScope): string | null {
  if (node.type === "identifier") {
    if (node.text === "self" || node.text === "cls") return scope.selfClass ?? null;
    return null; // a bare local is the kernel engine's binding case, not ours
  }
  if (node.type === "attribute") {
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    if (object?.type !== "identifier" || object.text !== "self" || attribute === null) return null;
    return scope.fieldType(attribute.text);
  }
  if (node.type === "await") {
    // `?? node` would recurse on itself forever on a malformed parse; silence is the answer.
    const awaited = node.namedChildren[0];
    return awaited === undefined ? null : pythonReturnExpressionType(awaited, scope);
  }
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn === null) return null;
  if (fn.type === "identifier") {
    if (fn.text === "cls") return scope.selfClass ?? null;
    if (PYTHON_CLASS_NAME.test(fn.text)) return fn.text;
    return scope.fileReturn(fn.text);
  }
  if (fn.type === "attribute" && scope.selfClass !== undefined) {
    if (isSelfCopy(node, fn)) return PYTHON_SELF_RETURN;
    const attribute = fn.childForFieldName("attribute");
    if (isReceiverIdentifier(fn.childForFieldName("object")) && attribute !== null) {
      const returned = scope.selfMethodReturn(attribute.text);
      if (returned !== null) return returned;
    }
  }
  // `mod.Widget()` — the dotted spelling of a constructor; the LAST segment decides.
  if (fn.type === "attribute" || fn.type === "dotted_name") {
    const bare = pythonBareTypeName(fn.text);
    return PYTHON_CLASS_NAME.test(bare) ? bare : null;
  }
  return null;
}
