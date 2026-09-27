/**
 * Ruby's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.3) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: method and lambda parameters, locals and ivar fields
 * declared by a plain assignment.
 *
 * Ruby writes no annotations, so the only syntactic type is a constructor:
 * `X.new` / `Foo::Bar.new` on the right of the assignment. Any other call
 * (`X.find`, `find_x!`) is left untyped here — its type is joined at sink time
 * from the return-type channels. A compound assignment (`x += 1`) and a
 * multiple assignment (`a, b = …`) declare nothing new for the lexicon.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  boundCalleeFromCallShape,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";
import { typeConstantName } from "../ast-utils.js";
import { rubyCallShape } from "../call-collection.js";

/** Parameter forms whose declared name is the `name` field; a bare `identifier` is its own name. */
const NAMED_PARAMETER_TYPES = new Set([
  "optional_parameter",
  "keyword_parameter",
  "splat_parameter",
  "hash_splat_parameter",
  "block_parameter",
]);

function parameterSites(list: AstNode): DeclaredIdentifierSite[] {
  const sites: DeclaredIdentifierSite[] = [];
  for (const child of list.namedChildren) {
    const nameNode =
      child.type === "identifier"
        ? child
        : NAMED_PARAMETER_TYPES.has(child.type)
          ? child.childForFieldName("name")
          : null;
    if (nameNode) sites.push({ nameNode, kind: "param" });
  }
  return sites;
}

const ASSIGNMENT_KIND_BY_LEFT_TYPE: Readonly<Record<string, DeclaredIdentifierSite["kind"]>> = {
  identifier: "local",
  instance_variable: "field",
};

const assignmentRule: IdentifierDeclarationRule = {
  nodeType: "assignment",
  collect: (node) => {
    const left = node.childForFieldName("left");
    const kind = left ? ASSIGNMENT_KIND_BY_LEFT_TYPE[left.type] : undefined;
    if (!left || kind === undefined) return [];
    return [{ nameNode: left, kind, valueNode: node.childForFieldName("right") }];
  },
};

/**
 * `X.new` / `Foo::Bar.new` → the receiver as written; anything else is not a
 * constructor. A value-scoped constant (`adapter::Client.new`) names no type
 * the walk knows ({@link typeConstantName}, bd tea-rags-mcp-bjfa0).
 */
function rubyConstructorType(value: AstNode): IdentifierSyntacticType | undefined {
  if (value.type !== "call" || value.childForFieldName("method")?.text !== "new") return undefined;
  const receiver = value.childForFieldName("receiver");
  return receiver && typeConstantName(receiver) !== null ? { typeName: receiver.text } : undefined;
}

export const RUBY_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    { nodeType: "method_parameters", collect: parameterSites },
    { nodeType: "lambda_parameters", collect: parameterSites },
    assignmentRule,
  ],
  annotationType: () => undefined,
  constructorType: rubyConstructorType,
  boundCalleeOf: (value) => boundCalleeFromCallShape(rubyCallShape(value)),
};
