/**
 * TypeScript type-abstractness census (bd tea-rags-mcp-r8hme.8), read by the
 * kernel's census facet:
 *
 *   | declaration                                                       | counts as |
 *   | ----------------------------------------------------------------- | --------- |
 *   | `abstract class`                                                  | abstract  |
 *   | EXPORTED interface / object-type alias that is a behaviour        | abstract  |
 *   | contract: a method, call or construct signature, or mostly        |           |
 *   | function-typed properties                                         |           |
 *   | `class`                                                           | concrete  |
 *   | any other interface or alias (data shape, props, union), an enum, | neither   |
 *   | a behaviour contract the file keeps to itself                     |           |
 *
 * Martin's A asks how much of a component is open to substitution: how many of
 * its types a dependent programs against while someone else supplies the
 * behaviour. Each clause above is measured, on taxdome's 14,567 TypeScript
 * files (85 classes):
 *
 * - a function-typed property alone is the React props shape
 *   (`onClose: () => void`): counting any of them read 3,571 types as abstract
 *   and every component directory as pure abstraction;
 * - requiring MOST members to be functions still left 796, nearly all a
 *   file-local `type Props`;
 * - a contract the file does not export cannot be implemented or depended on
 *   outside it, so it opens nothing to dependents: exported-only leaves 88,
 *   the handles, sources, workers and operation bundles other files program
 *   against. On this repository the same rule keeps 121 of 136 — the ports in
 *   `contracts/` are written as function-typed properties, which is why
 *   method signatures alone (17) would miss them.
 *
 * Only declarations count: a class expression is a value.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";

const BEHAVIOUR_SIGNATURE_TYPES: ReadonlySet<string> = new Set([
  "method_signature",
  "call_signature",
  "construct_signature",
]);

/** A function type, seen through parentheses and an optional-value union (`(() => void) | undefined`). */
function isFunctionType(node: AstNode | null | undefined): boolean {
  if (!node) return false;
  if (node.type === "function_type" || node.type === "constructor_type") return true;
  if (node.type === "parenthesized_type" || node.type === "union_type") return node.namedChildren.some(isFunctionType);
  return false;
}

/**
 * Whether an interface body or an object type is a behaviour contract: it
 * declares a method, call or construct signature, or MOST of its members are
 * function-typed properties (`upsert: (row: Row) => Promise<void>`). A props
 * shape with a callback or two among its data fields is not.
 */
function declaresBehaviour(body: AstNode | null | undefined): boolean {
  if (!body) return false;
  let members = 0;
  let functionProperties = 0;
  for (const member of body.namedChildren) {
    if (BEHAVIOUR_SIGNATURE_TYPES.has(member.type)) return true;
    if (member.type === "comment") continue;
    members++;
    if (member.type === "property_signature" && isFunctionType(member.childForFieldName("type")?.namedChildren[0])) {
      functionProperties++;
    }
  }
  return functionProperties > members / 2;
}

/** Declared under `export` — the only way a dependent can program against it. */
const exported = (node: AstNode) => node.parent?.type === "export_statement";

export const readTypescriptTypeAbstractness: TypeAbstractnessReader = (node) => {
  switch (node.type) {
    case "abstract_class_declaration":
      return "abstract";
    case "class_declaration":
      return "concrete";
    case "interface_declaration":
      return exported(node) && declaresBehaviour(node.childForFieldName("body")) ? "abstract" : null;
    case "type_alias_declaration": {
      const value = node.childForFieldName("value");
      return exported(node) && value?.type === "object_type" && declaresBehaviour(value) ? "abstract" : null;
    }
    default:
      return null;
  }
};

export const typescriptTypeAbstractnessFacetPass: ExtractionFacetPass =
  typeAbstractnessFacetPass(readTypescriptTypeAbstractness);
