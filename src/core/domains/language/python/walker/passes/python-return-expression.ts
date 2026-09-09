/**
 * The Python half of the kernel's return-inference ports (E2 seam 5, bd
 * tea-rags-mcp-9fgdi): which expression shapes name a class, and nothing else.
 *
 * Five shapes, each one measured on the corpora rather than imagined:
 *   `Widget()`        a constructor call            → Widget
 *   `self`            a fluent method               → the enclosing class
 *   `cls` / `cls(…)`  a `@classmethod` factory      → the enclosing class
 *   `self.session`    a field the class TYPES       → that field's class
 *   `make()`          a SAME-FILE annotated callee  → its declared return
 *
 * The last one is deliberately same-file-only. A per-file walker pass has no
 * return types for another file's defs, and inventing a channel to defer the
 * hop would duplicate what `localCallBindings` does properly at resolve time.
 * One hop, no recursion: a same-file callee whose OWN return is itself inferred
 * is silence, because the pass has no fixpoint and a wrong return type poisons
 * every downstream chain hop.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { pythonBareTypeName } from "./python-type-annotation.js";

/** What the enclosing def can see: its class, that class's typed fields, and the file's annotated defs. */
export interface PythonReturnScope {
  /** Enclosing class short name; undefined at module level (`self` / `cls` are then meaningless). */
  readonly selfClass: string | undefined;
  /** `<field> → <class>` for the enclosing class, from its annotated assignments. */
  readonly fieldTypes: ReadonlyMap<string, string>;
  /** `<bare def name> → <declared return class>` for TOP-LEVEL defs in this file. */
  readonly fileReturnTypes: ReadonlyMap<string, string>;
}

/** A single capitalized identifier — Python's class-name convention. */
const PYTHON_CLASS_NAME = /^[A-Z]\w*$/;

export function pythonReturnExpressionType(node: AstNode, scope: PythonReturnScope): string | null {
  if (node.type === "identifier") {
    if (node.text === "self" || node.text === "cls") return scope.selfClass ?? null;
    return null; // a bare local is the kernel engine's binding case, not ours
  }
  if (node.type === "attribute") {
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute");
    if (object?.type !== "identifier" || object.text !== "self" || attribute === null) return null;
    return scope.fieldTypes.get(attribute.text) ?? null;
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
    return scope.fileReturnTypes.get(fn.text) ?? null;
  }
  // `mod.Widget()` — the dotted spelling of a constructor; the LAST segment decides.
  if (fn.type === "attribute" || fn.type === "dotted_name") {
    const bare = pythonBareTypeName(fn.text);
    return PYTHON_CLASS_NAME.test(bare) ? bare : null;
  }
  return null;
}
