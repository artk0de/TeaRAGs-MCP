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
 * no types — both type readers answer nothing. `x=$(f …)` (quoted or not) is
 * bound to `f` when the walker emits a `CallRef` for it — a function defined in
 * the same file; an external binary is no call edge, so it binds nothing.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import type {
  DeclaredIdentifierSite,
  IdentifierDeclarationRule,
  IdentifierDeclarationSyntax,
} from "../../../kernel/index.js";
import { bashCalledFunction, collectBashDefinedFunctions } from "../walker.js";

/** Declaration builtins whose bare `NAME` operand declares a variable. */
const DECLARING_BUILTINS = new Set(["local", "declare", "typeset", "readonly"]);

function insideFunction(node: AstNode): boolean {
  for (let current = node.parent; current !== null; current = current.parent) {
    if (current.type === "function_definition") return true;
  }
  return false;
}

function localSite(nameNode: AstNode | null, valueNode: AstNode | null = null): DeclaredIdentifierSite[] {
  return nameNode?.type === "variable_name" && insideFunction(nameNode) ? [{ nameNode, kind: "local", valueNode }] : [];
}

function assignmentSite(assignment: AstNode): DeclaredIdentifierSite[] {
  return localSite(assignment.childForFieldName("name"), assignment.childForFieldName("value"));
}

/** `name=value` / `arr=(a b)` — `a[1]=x` names a `subscript` and declares nothing new. */
const assignmentRule: IdentifierDeclarationRule = {
  nodeType: "variable_assignment",
  collect: assignmentSite,
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
      return child.type === "variable_assignment" ? assignmentSite(child) : [];
    });
  },
};

/** `for f in …` binds the loop variable. */
const forRule: IdentifierDeclarationRule = {
  nodeType: "for_statement",
  collect: (node) => localSite(node.childForFieldName("variable")),
};

/**
 * The defined-function set per file root. The syntax object is shared across
 * files, so the set is keyed on the root node; a materialized tree's root is a
 * stable object, a native one misses and recomputes — correct either way.
 */
const definedFunctionsByRoot = new WeakMap<AstNode, Set<string>>();

function definedFunctionsOf(node: AstNode): Set<string> {
  let root = node;
  while (root.parent !== null) root = root.parent;
  let defined = definedFunctionsByRoot.get(root);
  if (defined === undefined) {
    defined = collectBashDefinedFunctions(root);
    definedFunctionsByRoot.set(root, defined);
  }
  return defined;
}

/** `$(f …)` / `"$(f …)"` holding ONE command → that command; a pipeline or a list has no single callee. */
function substitutedCommand(value: AstNode): AstNode | null {
  const substitution = value.type === "string" && value.namedChildCount === 1 ? value.namedChildren[0] : value;
  if (substitution.type !== "command_substitution" || substitution.namedChildCount !== 1) return null;
  const command = substitution.namedChildren[0];
  return command.type === "command" ? command : null;
}

function bashBoundCallee(value: AstNode): IdentifierBoundCallee | undefined {
  const command = substitutedCommand(value);
  const member = command === null ? null : bashCalledFunction(command, definedFunctionsOf(command));
  return member === null ? undefined : { member };
}

export const BASH_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [assignmentRule, declarationCommandRule, forRule],
  annotationType: () => undefined,
  constructorType: () => undefined,
  boundCalleeOf: bashBoundCallee,
};
