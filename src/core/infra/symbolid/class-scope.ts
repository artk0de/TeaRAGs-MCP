/**
 * The TypeScript / JavaScript classes that scope a member's symbolId when no
 * top-level class declaration does (bd tea-rags-mcp-lyo4p):
 *
 *   vi.mock("./coordinator.js", () => ({
 *     EnrichmentCoordinator: class { constructor() { … } },   // EnrichmentCoordinator#constructor
 *   }));
 *   export const Recorder = class { record() { … } };        // Recorder#record
 *   function build() { class Local { run() { … } } }          // build.Local#run
 *
 * Before this, both producers lost the class. The walker named no class
 * EXPRESSION, so every constructor of every mock class in a file composed as a
 * bare `constructor`; the chunker composed a member of a class nested in a
 * function directly under the function (`build#run`) while the walker composed
 * `build.Local#run`. DIFFERENT symbols collapsed onto one id, and the chunk id
 * disagreed with the graph row.
 *
 * Lives in `infra/symbolid` for the reason `./const-object-namespace.ts` does:
 * the codegraph walker (`domains/language/typescript/walker/name-of.ts`) and the
 * chunker (`domains/ingest/pipeline/chunker/tree-sitter.ts`) must answer "which
 * class, under which name" identically, or they fall out of lockstep.
 */

import type { AstNode } from "../../contracts/types/ast.js";
import { unwrapTypeAssertions } from "./const-object-namespace.js";

/** The class node types a TypeScript / JavaScript member can sit in. */
const CLASS_NODE_TYPES = new Set(["class_declaration", "abstract_class_declaration", "class"]);

/**
 * The name a class EXPRESSION is reachable by, or null when nothing names it.
 *
 * The class's OWN name wins, exactly as it does for a declaration:
 * `{ default: class MockParser { parse() {} } }` is `MockParser#parse`, not
 * `default#parse` — a key like `default` names a module slot, not the class.
 * Only an unnamed class takes the name of what binds it, and two bindings count
 * — an object property (`X: class {}`) and a declarator (`const X = class {}`)
 * — each seen through `as` / `satisfies` / parentheses. An expression that
 * neither names itself nor is bound (`register(class {})`) stays anonymous, as
 * before.
 */
export function classExpressionName(node: AstNode): string | null {
  if (node.type !== "class") return null;
  const own = node.childForFieldName("name");
  if (own) return own.text;
  return bindingName(node);
}

function bindingName(classNode: AstNode): string | null {
  let current: AstNode | null = classNode.parent;
  let value: AstNode = classNode;
  while (
    current?.type === "as_expression" ||
    current?.type === "satisfies_expression" ||
    current?.type === "parenthesized_expression"
  ) {
    value = current;
    current = current.parent;
  }
  if (!current) return null;
  if (current.type === "pair") {
    if (current.childForFieldName("value") !== value) return null;
    const key = current.childForFieldName("key");
    return key?.type === "property_identifier" || key?.type === "identifier" ? key.text : null;
  }
  if (current.type === "variable_declarator") {
    const declared = current.childForFieldName("value");
    if (!declared || unwrapTypeAssertions(declared) !== classNode) return null;
    const id = current.childForFieldName("name");
    return id?.type === "identifier" ? id.text : null;
  }
  return null;
}

/**
 * Names of the classes enclosing `member`, outermost first, strictly below
 * `container` (the node whose name the caller already composed; null = walk to
 * the root). Answers only for a `method_definition` — the TypeScript /
 * JavaScript member type — so no other grammar's `class` node is ever read.
 *
 * A class that nothing names is skipped rather than ending the walk: the walker
 * composes nothing for it either, and its members join the next named scope out.
 */
export function enclosingClassScopeNames(member: AstNode, container: AstNode | null): string[] {
  if (member.type !== "method_definition") return [];
  const names: string[] = [];
  for (let p = member.parent; p && p !== container; p = p.parent) {
    if (!CLASS_NODE_TYPES.has(p.type)) continue;
    const name = p.type === "class" ? classExpressionName(p) : (p.childForFieldName("name")?.text ?? null);
    if (name) names.push(name);
  }
  return names.reverse();
}
