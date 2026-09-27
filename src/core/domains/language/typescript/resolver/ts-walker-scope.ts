/**
 * The walker's symbol coordinates for a `ts.Declaration` the checker hands back
 * (bd tea-rags-mcp-bv0tq).
 *
 * The checker names a declaration NODE; the symbol table names what
 * `collectSymbols` composed from `tsNameOf` — `main.send`, `Widget#render.format`,
 * `parseSnapshot.close`. `composeSymbolId` bridges the two for class members and
 * namespaces only, so a function-scoped helper the checker pins exactly was
 * still pinned by short name within its file — ambiguous as soon as two
 * functions of that file each declare a `send`. This module mirrors the one
 * thing the table records beside the id, the declaration's `scope`: the names
 * of the enclosing nodes `tsNameOf` names, outermost first. A candidate whose
 * scope and short name both match IS the declaration's row.
 *
 * The mirror follows `tsNameOf` (`typescript/walker/name-of.ts`) and the
 * `infra/symbolid` gates it calls. It answers `null` on any ancestor it cannot
 * name the way the walker would — a computed member name — so a shape the two
 * disagree on declines instead of guessing.
 */

import ts from "typescript";

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import { lookupEcmascriptSymbolsByShortName } from "../../shared/ecmascript-symbol-lookup.js";

/** An arrow or function expression — the value `functionValuedDeclaratorName` accepts. */
export function isFunctionValuedInitializer(initializer: ts.Expression | undefined): boolean {
  return initializer !== undefined && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer));
}

export function sameWalkerScope(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

/**
 * The `scope` `collectSymbols` gives the symbol it records for `declaration`,
 * or `null` when an ancestor sits in a shape the mirror does not reproduce.
 */
export function walkerScopeOf(declaration: ts.Node): string[] | null {
  const names: string[] = [];
  for (let ancestor = declaration.parent; !ts.isSourceFile(ancestor); ancestor = ancestor.parent) {
    const name = walkerScopeName(ancestor);
    if (name === null) return null;
    if (name !== undefined) names.unshift(name);
  }
  return names;
}

/**
 * The symbolId of the caller-file row the walker recorded for a FUNCTION-SCOPED
 * callable the checker resolved to — a nested `function` declaration or a
 * function-valued declarator — or `null` when the declaration is another shape,
 * sits outside `targetRelPath`'s rows, or matches no row / several.
 */
export function pinFunctionByWalkerScope(declaration: ts.Node, targetRelPath: string, ctx: CallContext): string | null {
  const named = walkerNamedNodeOf(declaration);
  if (named === null) return null;
  const scope = walkerScopeOf(named.node);
  if (scope === null || scope.length === 0) return null;
  const rows = lookupEcmascriptSymbolsByShortName(ctx, named.shortName, { role: "callee" }).filter(
    (def) => def.relPath === targetRelPath && sameWalkerScope(def.scope, scope),
  );
  return rows.length === 1 ? rows[0].symbolId : null;
}

/** The node `tsNameOf` names for a callable declaration, with the name it records. */
function walkerNamedNodeOf(declaration: ts.Node): { node: ts.Node; shortName: string } | null {
  if (ts.isFunctionDeclaration(declaration)) {
    if (declaration.asteriskToken !== undefined || declaration.name === undefined) return null;
    return { node: declaration, shortName: declaration.name.text };
  }
  if (ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) {
    const { parent } = declaration;
    if (ts.isVariableDeclaration(parent) && parent.initializer === declaration && ts.isIdentifier(parent.name)) {
      return { node: parent, shortName: parent.name.text };
    }
    return null;
  }
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    isFunctionValuedInitializer(declaration.initializer)
  ) {
    return { node: declaration, shortName: declaration.name.text };
  }
  return null;
}

/** `undefined` = the walker names nothing here; `null` = a name the mirror cannot reproduce. */
function walkerScopeName(node: ts.Node): string | null | undefined {
  if (ts.isFunctionDeclaration(node)) {
    // tsNameOf names `function_declaration`, not `generator_function_declaration`.
    if (node.asteriskToken !== undefined || node.name === undefined) return undefined;
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return memberName(node.name);
  }
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isClassDeclaration(node)) return node.name?.text;
  if (ts.isClassExpression(node)) return node.name?.text ?? classExpressionBindingName(node);
  if (ts.isPropertyDeclaration(node)) {
    return isFunctionValuedInitializer(node.initializer) ? memberName(node.name) : undefined;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    if (isFunctionValuedInitializer(node.initializer)) return node.name.text;
    if (isObjectNamespaceInitializer(node.initializer)) return node.name.text;
  }
  return undefined;
}

function memberName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  return null;
}

function unwrapTypeAssertions(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** `constObjectNamespaceName`: an object literal carrying at least one method. */
function isObjectNamespaceInitializer(initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) return false;
  const object = unwrapTypeAssertions(initializer);
  return (
    ts.isObjectLiteralExpression(object) &&
    object.properties.some(
      (property) =>
        ts.isMethodDeclaration(property) ||
        ts.isGetAccessorDeclaration(property) ||
        ts.isSetAccessorDeclaration(property),
    )
  );
}

/** `classExpressionName`'s binding arm: `const X = class {}` / `{ X: class {} }`. */
function classExpressionBindingName(node: ts.ClassExpression): string | undefined {
  let value: ts.Node = node;
  let { parent } = node;
  while (ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isParenthesizedExpression(parent)) {
    value = parent;
    ({ parent } = parent);
  }
  if (ts.isVariableDeclaration(parent) && parent.initializer === value && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && parent.initializer === value && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return undefined;
}
