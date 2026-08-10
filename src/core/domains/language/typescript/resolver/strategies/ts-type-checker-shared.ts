/**
 * symbolId composition mechanics shared by the TypeScript type-checker passes
 * (bd tea-rags-mcp-un8mv).
 *
 * Every checker pass ends the same way: the compiler hands back a
 * `ts.Declaration`, and the pass has to phrase it as a project symbolId before
 * the run's `GlobalSymbolTable` will confirm it. Which separator goes between an
 * owner and its member, which enclosing `namespace` names prefix it, what the
 * owner is called — that is one question with one answer, and
 * `.claude/rules/symbolid-convention.md` says so directly: a resolver writing
 * `join(".")` for itself is an anti-pattern, the separator belongs in a helper.
 *
 * The passes nevertheless carried their own copies through the epic's Wave 2,
 * when they were authored on concurrent branches and any shared edit would have
 * collided on every merge. The duplication bought merge throughput, never
 * design; this module is where the copies converge now that the tier has
 * settled.
 *
 * What deliberately does NOT live here is the policy each pass layers on top —
 * where the member name comes from, and what to do when the owner has no name at
 * all. `composeSymbolId` degrades to the bare short name there, while
 * `composeMemberSymbolId` declines outright, and each behaviour is load-bearing
 * for its own pass's contract. Sharing the mechanics does not make the policies
 * one policy.
 *
 * Kept apart from `./shared.ts` along the dependency seam: that module holds
 * `ResolverConfig` and the import mapper that EVERY strategy needs, and it
 * reaches for nothing from the compiler. Everything here takes a `ts` AST node,
 * which only a pass already holding a checker result ever has.
 */

import ts from "typescript";

import { INSTANCE_METHOD_SEPARATOR } from "../../../../../infra/symbolid/index.js";

/** TypeScript joins namespaces and static members with a dot. */
export const TS_SCOPE_SEPARATOR = ".";

/** `#` for instance members, `.` for `static` ones — the universal convention. */
export function memberSeparator(declaration: ts.Declaration): string {
  const isStatic = ts.canHaveModifiers(declaration)
    ? (ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
    : false;
  return isStatic ? TS_SCOPE_SEPARATOR : INSTANCE_METHOD_SEPARATOR;
}

/** Prepend the enclosing `namespace` / `module` names, outermost first. */
export function prefixWithNamespaces(node: ts.Node, name: string): string {
  const scopes: string[] = [];
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined) {
    if (ts.isModuleDeclaration(cursor) && ts.isIdentifier(cursor.name)) scopes.unshift(cursor.name.text);
    cursor = cursor.parent;
  }
  return scopes.length === 0 ? name : `${scopes.join(TS_SCOPE_SEPARATOR)}${TS_SCOPE_SEPARATOR}${name}`;
}

/**
 * The class or interface a declaration is a member of, or `null` for the
 * structural containers — an object literal, a type literal, a mapped type —
 * which is precisely the case that has no name to look up. An anonymous class
 * expression reaches the same `null` through its missing name.
 */
export function declarationOwnerName(declaration: ts.Declaration): string | null {
  const owner = declaration.parent as ts.Node | undefined;
  if (owner === undefined) return null;
  if (!ts.isClassLike(owner) && !ts.isInterfaceDeclaration(owner)) return null;
  return owner.name?.text ?? null;
}
