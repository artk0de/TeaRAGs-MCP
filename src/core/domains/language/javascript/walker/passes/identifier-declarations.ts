/**
 * JavaScript's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.4) — the
 * ECMAScript half of TypeScript's, with no annotations. The JavaScript grammar
 * has no `required_parameter`: a `formal_parameters` list holds the binding
 * targets themselves (`id`, `opts = …`, `{ a }`, `[x]`, `...more`). The only
 * syntactic type is `new X()`. A local or field bound to a call carries that
 * call's callee, split the way this walker splits its `CallRef`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  boundCalleeFromCallShape,
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";
import {
  ECMASCRIPT_ARROW_PARAMETER_RULE,
  ECMASCRIPT_VARIABLE_DECLARATOR_RULE,
  ecmascriptBindingSites,
  ecmascriptConstructorTypeName,
  ecmascriptOutermostCall,
} from "../../../typescript/walker/passes/identifier-declarations.js";
import { javascriptCallSiteShape } from "../walker.js";

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
  boundCalleeOf: (value) => boundCalleeFromCallShape(javascriptCallSiteShape(ecmascriptOutermostCall(value))),
};
