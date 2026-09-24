/**
 * Bash's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.6) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: the variables a function declares, through a plain
 * assignment (`name=value`), a `local` / `declare` / `typeset` / `readonly`
 * declaration (bare `local count` included) or a `for` loop variable.
 *
 * Only inside a function: a file-scope variable has no owning chunk, and a
 * declaration is recorded against the function it belongs to. `export NAME`
 * without `=` re-exports an existing variable and declares nothing. Bash has
 * no types — both type readers answer nothing.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type {
  DeclaredIdentifierSite,
  IdentifierDeclarationRule,
  IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";

/** Declaration builtins whose bare `NAME` operand declares a variable. */
const DECLARING_BUILTINS = new Set(["local", "declare", "typeset", "readonly"]);

function insideFunction(node: AstNode): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.type === "function_definition") return true;
  }
  return false;
}

function localSite(nameNode: AstNode | null): DeclaredIdentifierSite[] {
  return nameNode?.type === "variable_name" && insideFunction(nameNode) ? [{ nameNode, kind: "local" }] : [];
}

/** `name=value` / `arr=(a b)` — `a[1]=x` names a `subscript` and declares nothing new. */
const assignmentRule: IdentifierDeclarationRule = {
  nodeType: "variable_assignment",
  collect: (node) => localSite(node.childForFieldName("name")),
};

/**
 * `local target="$1" count` — every operand in order: a bare name, or the name
 * of an assignment (which the assignment rule meets again later, as a
 * duplicate the pass drops). `export NAME=1` still declares through that rule.
 */
const declarationCommandRule: IdentifierDeclarationRule = {
  nodeType: "declaration_command",
  collect: (node) => {
    if (!DECLARING_BUILTINS.has(node.children[0]?.type ?? "")) return [];
    return node.namedChildren.flatMap((child) => {
      if (child.type === "variable_name") return localSite(child);
      return child.type === "variable_assignment" ? localSite(child.childForFieldName("name")) : [];
    });
  },
};

/** `for f in …` binds the loop variable. */
const forRule: IdentifierDeclarationRule = {
  nodeType: "for_statement",
  collect: (node) => localSite(node.childForFieldName("variable")),
};

export const BASH_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [assignmentRule, declarationCommandRule, forRule],
  annotationTypeName: () => undefined,
  constructorTypeName: () => undefined,
};
