/**
 * Ruby type-abstractness census (bd tea-rags-mcp-r8hme.8), read by the
 * kernel's census facet:
 *
 *   | declaration                                                  | counts as |
 *   | ------------------------------------------------------------ | --------- |
 *   | class or module with a `raise NotImplementedError` method    | abstract  |
 *   | any other class                                              | concrete  |
 *   | module defining methods of its own (a mixin, a utility)      | concrete  |
 *   | module defining no method (a namespace)                      | neither   |
 *
 * Ruby has no abstract keyword; the idiom that leaves a method to subclasses
 * or includers is a body that is exactly `raise NotImplementedError`, which is
 * what the reading keys on (`isRubyNotImplementedStub`). A method counts as the
 * declaration's own when it sits directly in its body or in its
 * `class << self` block — a nested class or module is judged on its own.
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
  if (node.type === "module" && methods.length === 0) return null;
  return "concrete";
};

export const rubyTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass(readRubyTypeAbstractness);
