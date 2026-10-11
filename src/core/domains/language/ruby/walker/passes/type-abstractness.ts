/**
 * Ruby type-abstractness census (bd tea-rags-mcp-r8hme.8), read by the
 * kernel's census facet:
 *
 *   | declaration                                                  | counts as |
 *   | ------------------------------------------------------------ | --------- |
 *   | class or module with a `raise NotImplementedError` method    | abstract  |
 *   | any other class that defines a method other than             | concrete  |
 *   | `initialize`                                                 |           |
 *   | class whose own methods are all `initialize` — the           | neither   |
 *   | constructor — or that defines none (bd tea-rags-mcp-44cpv    |           |
 *   | c-1=a: an error class, a data object of attr accessors)      |           |
 *   | module defining methods of its own (a mixin, a utility)      | concrete  |
 *   | module defining no method (a namespace)                      | neither   |
 *
 * Ruby has no abstract keyword; the idiom that leaves a method to subclasses
 * or includers is a body that is exactly `raise NotImplementedError`, which is
 * what the reading keys on (`isRubyNotImplementedStub`). A method counts as the
 * declaration's own when it sits directly in its body or in its
 * `class << self` block — a nested class or module is judged on its own.
 * `initialize` is Ruby's constructor, so it is data in the behaviour-free
 * reading, not behaviour; `attr_accessor` and friends are calls, not defs, and
 * read as accessors — data — the same way.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";
import { isRubyNotImplementedStub } from "../method-signatures.js";

const METHOD_TYPES: ReadonlySet<string> = new Set(["method", "singleton_method"]);

/** The methods a class or module body defines itself, `class << self` included. */
function ownMethods(body: AstNode | null): AstNode[] {
  if (!body) return [];
  const out: AstNode[] = [];
  for (const child of body.namedChildren) {
    if (METHOD_TYPES.has(child.type)) out.push(child);
    else if (child.type === "singleton_class") out.push(...ownMethods(child.childForFieldName("body")));
  }
  return out;
}

export const readRubyTypeAbstractness: TypeAbstractnessReader = (node) => {
  if (node.type !== "class" && node.type !== "module") return null;
  const methods = ownMethods(node.childForFieldName("body"));
  if (methods.some(isRubyNotImplementedStub)) return "abstract";
  if (node.type === "module") return methods.length === 0 ? null : "concrete";
  // 44cpv c-1: `initialize` is the constructor, not behaviour. A class whose
  // own methods are all constructors — or that defines none, its body holding
  // only attr accessors, constants and assignments — declares no behaviour.
  return methods.every((m) => m.type === "method" && m.childForFieldName("name")?.text === "initialize")
    ? null
    : "concrete";
};

export const rubyTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass(readRubyTypeAbstractness);
