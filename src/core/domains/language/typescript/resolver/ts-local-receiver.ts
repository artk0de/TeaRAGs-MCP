/**
 * "Is this call's RECEIVER a value the enclosing scope was HANDED, with no
 * in-project type behind it?" — the receiver twin of {@link calleeIsLocalValueBinding}
 * (bd tea-rags-mcp-z0zqd).
 *
 * bd tea-rags-mcp-5tatv closed the BARE half of one gap. Its predicate returns
 * `false` the moment `call.receiver !== null`, by construction, because it
 * identifies the CALLEE identifier. A dispatching call whose RECEIVER is itself a
 * destructured local — `const { stageClientsHandlers } = useFieldArray()`, then
 * `stageClientsHandlers.remove(index)` — walks through the same blind spot
 * untouched:
 *
 *   - the walker's `localBindings` builder skips destructuring patterns, so
 *     `receiverTypeName` in `./ts-external-call.ts` yields nothing and the
 *     annotated-receiver arms of the external guard have no name to decide on;
 *   - `TSLocalBindingSymbolResolutionStrategy` needs that same missing binding;
 *   - `globalShortName` then matches the bare member against the whole symbol
 *     table and commits to whatever single project symbol shares it — the taxdome
 *     oracle recorded `remove` landing on an unrelated Quill
 *     `FontFamilyParchmentStyleAttributor#remove`.
 *
 * What this predicate is NOT is a second answer to the same question. The
 * checker-backed arm of the external guard (bd tea-rags-mcp-335eu, widened by bd
 * tea-rags-mcp-otm6n) already covers every receiver whose type RESOLVES to a
 * declaration outside the project — which is exactly what a `react-hook-form`
 * handler object is, and measurably so: the bead's headline example is declined
 * by that arm on the current tree. The residual it cannot reach by construction
 * is the receiver with no resolvable type AT ALL — `any`, an unannotated
 * destructured parameter, an unresolved import. There `typeDeclaredOutsideProject`
 * answers "no evidence" deliberately, because that arm may only ever ADD an
 * external verdict, and a guard that read absence of declarations as "declared
 * elsewhere" would decline calls on no evidence at all. So the call fell through
 * to pass 9 with nothing standing in the way.
 *
 * The evidence this predicate adds is the DECLARATION, not the type: a parameter
 * or a binding element is a value supplied at runtime, so a short-name match on
 * its member is fabricated whenever the project cannot name the receiver's type.
 * Both halves are required. Neither alone is enough — an ordinary local holding a
 * project instance is a binding the chain SHOULD resolve, and an untypable
 * receiver that is a module-level `const` is somebody else's case.
 *
 * Deliberately NOT folded into `targetsExternalImport`, for the reason bd
 * tea-rags-mcp-5tatv gave one pass over: the handler a parent component passes
 * down is usually project code we simply cannot pin, so marking it external would
 * buy precision with an inflated `resolveSuccessRate`. It stays an internal miss.
 */

import ts from "typescript";

import type { CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import { findReceiverExpression } from "./strategies/ts-type-checker-shared.js";
import { isLocalValueBinding } from "./ts-local-callee.js";
import type { TSProgramCache } from "./ts-program-cache.js";

/**
 * `true` when `call` dispatches on a receiver that is declared by a local value
 * binding — a parameter, a binding element of a destructuring pattern, or a
 * variable declared inside a function body (bd tea-rags-mcp-w7qv4) — AND the
 * type checker names no in-project declaration for it.
 *
 * Three cheap gates come first, and the symbol-table one is load-bearing for
 * cost exactly as it is in {@link calleeIsLocalValueBinding}: with no project
 * symbol of that member name, neither short-name pass can produce anything, so
 * the verdict cannot change an edge and is not worth building a Program for.
 * That keeps the checker off the overwhelming majority of dispatching calls.
 *
 * Returns `false` whenever the evidence is absent — no Program, no locatable
 * node, a receiver that is not a plain identifier, an unresolved symbol. `this`
 * and `super` never reach the checker: they are earlier passes' business, and
 * neither is an `Identifier` in the AST anyway.
 */
export function receiverIsUnpinnableLocalValueBinding(
  call: CallRef,
  ctx: CallContext,
  programCache: TSProgramCache | null,
): boolean {
  const { receiver } = call;
  if (programCache === null || receiver === null || call.member.length === 0) return false;
  if (!isBareIdentifierText(receiver)) return false;
  if (ctx.symbolTable.lookupByShortName(call.member).length === 0) return false;
  const handle = programCache.acquire(ctx.callerFile);
  if (handle === null) return false;
  const node = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
  if (node === null || !ts.isIdentifier(node)) return false;
  const { checker } = handle;
  const declarations = checker.getSymbolAtLocation(node)?.getDeclarations() ?? [];
  if (declarations.length === 0 || !declarations.every(isLocalValueBinding)) return false;
  return !typeNamesProjectDeclaration(checker, checker.getTypeAtLocation(node), programCache);
}

/**
 * Could this receiver TEXT be a single identifier? A pure cost gate — the
 * `ts.isIdentifier` check above is the authoritative one, but it costs a
 * `ts.Program`, and a chained (`a.b`), indexed (`a[k]`) or self (`this`)
 * receiver can be ruled out from the walker's text alone.
 */
function isBareIdentifierText(receiver: string): boolean {
  if (receiver.length === 0 || receiver === "this" || receiver === "super") return false;
  return !receiver.includes(".") && !receiver.includes("[") && !receiver.includes("(");
}

/**
 * Does ANY constituent of `type` have a declaration among the project's own
 * sources?
 *
 * The quantifier is the recall guard, and it is deliberately the mirror image of
 * the one in `typeDeclaredOutsideProject`: there, one in-project constituent
 * sinks an EXTERNAL verdict; here, one in-project constituent saves the edge. A
 * receiver typed `ProjectStore` — however it was bound — can genuinely reach
 * `ProjectStore#save`, and a union that merely MIGHT reach the project on this
 * call is not evidence enough to decline.
 *
 * The two predicates are near-neighbours but not complements, which is why this
 * one is written out rather than negated from the other. They disagree on
 * precisely the population this module exists for: a type with no symbol (`any`,
 * an anonymous shape, an unresolved import) or a symbol no source declares is
 * "not external" to that predicate and "not in-project" to this one, and both
 * answers are correct for their own question.
 *
 * `getApparentType` matches what the external guard reads, so a receiver's
 * primitive or type-parameter constraint is resolved the same way in both.
 */
function typeNamesProjectDeclaration(checker: ts.TypeChecker, type: ts.Type, programCache: TSProgramCache): boolean {
  for (const constituent of type.isUnion() ? type.types : [type]) {
    const declarations = checker.getApparentType(constituent).getSymbol()?.getDeclarations() ?? [];
    for (const declaration of declarations) {
      if (programCache.isProjectSourceFile(declaration.getSourceFile().fileName)) return true;
    }
  }
  return false;
}
