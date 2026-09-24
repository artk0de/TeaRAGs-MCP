/**
 * JavaScript's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.4) — the
 * ECMAScript half of TypeScript's, with no annotations. The JavaScript grammar
 * has no `required_parameter`: a `formal_parameters` list holds the binding
 * targets themselves (`id`, `opts = …`, `{ a }`, `[x]`, `...more`). The only
 * syntactic type is `new X()`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";
import {
  ECMASCRIPT_ARROW_PARAMETER_RULE,
  ECMASCRIPT_VARIABLE_DECLARATOR_RULE,
  ecmascriptBindingSites,
  ecmascriptConstructorTypeName,
} from "../../../typescript/walker/passes/identifier-declarations.js";

function formalParameterSites(list: AstNode): DeclaredIdentifierSite[] {
  return list.namedChildren.flatMap((param) =>
    param.type === "assignment_pattern"
      ? ecmascriptBindingSites(param.childForFieldName("left"), "param", null, param.childForFieldName("right"))
      : ecmascriptBindingSites(param, "param"),
  );
}

export const JAVASCRIPT_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    { nodeType: "formal_parameters", collect: formalParameterSites },
    ECMASCRIPT_ARROW_PARAMETER_RULE,
    ECMASCRIPT_VARIABLE_DECLARATOR_RULE,
    fieldRule("field_definition", "field", { name: "property", value: "value" }),
  ],
  annotationTypeName: () => undefined,
  constructorTypeName: ecmascriptConstructorTypeName,
};
