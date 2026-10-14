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
 *   | `class` that declares behaviour of its own — a method, a static  | concrete  |
 *   | method, an abstract method signature, a function-valued property |           |
 *   | top-level `const` typed by (or `satisfies`) a named contract —    | concrete  |
 *   | never a utility generic like `Record<…>` — whose object literal  |           |
 *   | is at least half behaviour (methods, function-valued pairs)      |           |
 *   | `class` whose members are only a constructor, property fields    | neither   |
 *   | and accessors (bd tea-rags-mcp-44cpv c-1=a: an Error subclass,   |           |
 *   | a data-only shape; an empty class is the degenerate case)        |           |
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
 * The behaviour-free clause (44cpv) reads member KINDS, never a base-list
 * spelling: an `Error` subclass and a data-only class are the same reading,
 * and the boundary calls (function-valued property = behaviour, static data =
 * data, parameter property = field, accessors = data, `static { … }` block =
 * initializer) live with the kernel's `isBehaviourFreeClassBody` doc.
 *
 * Only declarations count: a class expression is a value.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  isBehaviourFreeClassBody,
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";
import { TS_UTILITY_TYPES } from "../../utility-types.js";

const BEHAVIOUR_SIGNATURE_TYPES: ReadonlySet<string> = new Set([
  "method_signature",
  "call_signature",
  "construct_signature",
]);

/** A function VALUE on a class property: an arrow or a function expression (`handler = async () => {}`). */
function isFunctionValuedProperty(node: AstNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

/**
 * Whether one class-body member declares behaviour: a method that is neither
 * the constructor nor an accessor, an abstract method signature, or a property
 * holding a function value. A method SIGNATURE (an overload, or every method of
 * an ambient `declare class` / `.d.ts` class) is a method under the same
 * constructor and accessor exclusions (bd tea-rags-mcp-89k7k.38). Everything else — fields, parameter-property
 * constructors, getters/setters, index signatures, a `static { … }` block — is
 * data or initialization.
 */
function classMemberDeclaresBehaviour(member: AstNode): boolean {
  switch (member.type) {
    case "method_definition":
    case "method_signature":
      if (member.childForFieldName("name")?.text === "constructor") return false;
      return !member.children.some((child) => child.type === "get" || child.type === "set");
    case "abstract_method_signature":
      return true;
    case "public_field_definition":
      return isFunctionValuedProperty(member.childForFieldName("value"));
    default:
      return false;
  }
}

/** A function type, seen through parentheses and an optional-value union (`(() => void) | undefined`). */
export function isFunctionType(node: AstNode | null | undefined): boolean {
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

/** Type nodes that spell a named type: `Foo`, `ns.Foo`, `Foo<T>`. */
const NAMED_TYPE_NODE_TYPES: ReadonlySet<string> = new Set([
  "type_identifier",
  "nested_type_identifier",
  "generic_type",
]);

/**
 * Whether a type node names a contract a value can implement: a named type
 * (`Detector`, `ns.Port`, `Handler<Event>`) that is not one of TypeScript's
 * own type-level operators (`Record<…>`, `Partial<…>` — {@link TS_UTILITY_TYPES}),
 * which describe a transformation and name no contract.
 */
function namesContract(type: AstNode | null | undefined): boolean {
  if (!type || !NAMED_TYPE_NODE_TYPES.has(type.type)) return false;
  const name = type.type === "generic_type" ? type.childForFieldName("name") : type;
  return !TS_UTILITY_TYPES.has(name?.text ?? "");
}

/**
 * Whether an object literal supplies behaviour (bd tea-rags-mcp-mqaj7, cut V2):
 * at least one member, and at least half of the non-spread members, is a
 * method that is not an accessor or a property holding a function value. A
 * spread carries members nobody can see here and counts on neither side.
 */
function objectLiteralDeclaresBehaviour(literal: AstNode): boolean {
  let members = 0;
  let behaviourMembers = 0;
  for (const member of literal.namedChildren) {
    if (member.type === "comment" || member.type === "spread_element") continue;
    members++;
    const isBehaviour =
      member.type === "method_definition"
        ? !member.children.some((child) => child.type === "get" || child.type === "set")
        : member.type === "pair" && isFunctionValuedProperty(member.childForFieldName("value"));
    if (isBehaviour) behaviourMembers++;
  }
  return behaviourMembers > 0 && behaviourMembers * 2 >= members;
}

/** A `const` declared at the top of the file, exported or not. */
function isTopLevelConst(declarator: AstNode): boolean {
  const declaration = declarator.parent;
  if (declaration?.type !== "lexical_declaration" || declaration.children[0]?.type !== "const") return false;
  const container = declaration.parent?.type === "export_statement" ? declaration.parent.parent : declaration.parent;
  return container?.type === "program";
}

/**
 * Whether a variable declarator is an object-literal implementation of a named
 * contract (bd tea-rags-mcp-mqaj7): a top-level `const` whose literal value is
 * typed by a contract — `const d: Detector = { … }` or
 * `const d = { … } satisfies Detector` — and supplies behaviour. It is the
 * strategy-object form of `class SizeDetector implements Detector`, and counts
 * as that class would. A function initializer is a value, not a type, and an
 * unannotated literal names nothing it implements.
 */
function implementsContractAsObjectLiteral(declarator: AstNode): boolean {
  if (!isTopLevelConst(declarator)) return false;
  let value = declarator.childForFieldName("value");
  let contractNamed = namesContract(declarator.childForFieldName("type")?.namedChildren[0]);
  if (value?.type === "satisfies_expression") {
    const [satisfied, satisfiedType] = [value.namedChildren[0], value.namedChildren.at(-1)];
    contractNamed ||= namesContract(satisfiedType);
    value = satisfied;
  }
  return contractNamed && value?.type === "object" && objectLiteralDeclaresBehaviour(value);
}

export const readTypescriptTypeAbstractness: TypeAbstractnessReader = (node) => {
  switch (node.type) {
    case "variable_declarator":
      return implementsContractAsObjectLiteral(node) ? "concrete" : null;
    case "abstract_class_declaration":
      return "abstract";
    case "class_declaration":
      return isBehaviourFreeClassBody(node.childForFieldName("body"), classMemberDeclaresBehaviour) ? null : "concrete";
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
