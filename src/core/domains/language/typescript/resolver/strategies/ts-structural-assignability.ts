/**
 * "Can a value of this STRUCTURAL descendant be the receiver at all?" — the
 * checker's half of the cone's structural gate (bd tea-rags-mcp-iw702).
 *
 * The kernel derives `structural` hierarchy rows from member NAMES and ARITY
 * alone (`kernel/structural-conformance.ts`): an owner carrying every required
 * member of an interface at a compatible positional count conforms. Types are
 * invisible there, so `class TreeContentHashes extends Map<string, string>`,
 * whose `get(relPath)` returns `string | undefined`, conformed to every
 * single-member registry port `{ get(collectionName): CollectionEntry | null }`
 * and the cone fanned each `registry.get(...)` out to it.
 *
 * The answer is `checker.isTypeAssignableTo(descendant value type, receiver
 * type)` — the WHOLE value, not just the called member. A value reaches the
 * receiver only by being assignable to the receiver's declared type, so this is
 * the necessary condition the dispatch actually needs; the called member's own
 * signature is a weaker one. The receiver type is read AT THE CALL SITE, so a
 * generic interface is compared in its instantiation (`Port<string>`), never
 * against its unbound parameters.
 *
 * Every exit lacking evidence answers `true` — the row stays, exactly as before
 * the gate: no Program, no locatable receiver, a receiver type that names no
 * contract of `baseType`'s name, a descendant file the caller's Program does not
 * hold, an owner declaration not found at the top level of its file, and a
 * GENERIC owner, whose declared type carries its own unbound parameters and so
 * would fail any concrete receiver type it is in fact instantiated to satisfy.
 *
 * Unlike the derivation itself, the veto reads the CALLER's Program, so under
 * closure-batch or per-entry coverage a descendant file outside that Program
 * keeps its row: the gate only ever removes, and only on proof.
 */

import type ts from "typescript";

import type { CallContext, CallRef, RelPath } from "../../../../../contracts/types/codegraph.js";
import { loadTypeScriptCompiler, type TSProgramCache } from "../program/index.js";
import { findReceiverExpression } from "./ts-type-checker-shared.js";
import { typeConstituents } from "./ts-type-constituents.js";

export function structuralDescendantIsAssignable(
  descendant: string,
  baseType: string,
  descendantFile: RelPath | null,
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): boolean {
  if (programCache === null || descendantFile === null || !call.receiver) return true;
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return true;
  const node = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null) return true;
  const { checker, program } = handle;
  const receiverType = constituentNamed(checker, checker.getTypeAtLocation(node), bareName(baseType));
  if (receiverType === undefined) return true;
  const sourceFile = program.getSourceFile(compilerPath(programCache.repoRoot, descendantFile));
  if (sourceFile === undefined) return true;
  const descendantType = ownerValueType(checker, sourceFile, bareName(descendant));
  if (descendantType === undefined) return true;
  return checker.isTypeAssignableTo(descendantType, receiverType);
}

/** The receiver constituent whose interface or alias symbol is named `name`, or `undefined`. */
function constituentNamed(checker: ts.TypeChecker, type: ts.Type, name: string): ts.Type | undefined {
  return typeConstituents(checker, type).find(
    (constituent) => constituent.aliasSymbol?.getName() === name || constituent.getSymbol()?.getName() === name,
  );
}

/**
 * The type of the VALUE an owner hands a receiver: a class's instance type, an
 * object-literal declarator's own type, a factory function's return type — or
 * `undefined` when the owner is not declared at the top level of `sourceFile`
 * in one of those shapes, or is generic.
 */
function ownerValueType(checker: ts.TypeChecker, sourceFile: ts.SourceFile, name: string): ts.Type | undefined {
  const ts = loadTypeScriptCompiler();
  for (const statement of sourceFile.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      if ((statement.typeParameters?.length ?? 0) > 0) return undefined;
      const symbol = checker.getSymbolAtLocation(statement.name);
      return symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      if ((statement.typeParameters?.length ?? 0) > 0) return undefined;
      const signature = checker.getSignatureFromDeclaration(statement);
      return signature === undefined ? undefined : checker.getReturnTypeOfSignature(signature);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        const { initializer } = declaration;
        if (initializer === undefined || !ts.isObjectLiteralExpression(initializer)) return undefined;
        return checker.getTypeAtLocation(declaration.name);
      }
    }
  }
  return undefined;
}

function bareName(typeName: string): string {
  return typeName.slice(typeName.lastIndexOf(".") + 1);
}

/** `<repoRoot>/<relPath>` in the forward-slash form the compiler names files by. */
function compilerPath(repoRoot: string, relPath: RelPath): string {
  const root = repoRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  return `${root}/${relPath}`;
}
