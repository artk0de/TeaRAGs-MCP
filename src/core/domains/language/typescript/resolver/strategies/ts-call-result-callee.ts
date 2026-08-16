/**
 * BARE call whose callee is a local binding produced by CALLING a project
 * function (bd tea-rags-mcp-kf42k) — the factory twin of `importedCallee`,
 * which asks the same question of a binding an IMPORT introduced.
 *
 * Two syntactic shapes, one defect:
 *
 * ```ts
 * const { checkGuards } = useResolverGuards();   // file A calls file B's hook
 * checkGuards([...]);                            // → useResolverGuards.checkGuards
 *
 * const tButton = scopedTranslation("buttons");  // module scope
 * tButton("cancel");                             // → scopedTranslation.t
 * ```
 *
 * Neither reaches any earlier pass with anything to match on. Passes 1-5, 7 and
 * 8 gate on `call.receiver`; `importedCallee` reads `importedBindings`, and
 * neither name was ever imported; `sameFile` looks inside the CALLER's file.
 * That leaves the two short-name passes, and they fail in OPPOSITE directions —
 * which is why the family needed one answer rather than two patches:
 *
 *   - `checkGuards` DOES collide with a project short name, so `globalShortName`
 *     would have committed to whichever symbol shares it. That is exactly the
 *     fabrication `calleeIsLocalValueBinding` was added to decline (bd
 *     tea-rags-mcp-5tatv), and declining stays right — the guard has no way to
 *     tell which project symbol the binding actually holds;
 *   - `tButton` collides with NOTHING. The name is the call site's own
 *     invention, the symbol table has never heard it, and no amount of
 *     name-matching can ever produce a target for it.
 *
 * What both DO have is a compiler answer. `getResolvedSignature` names the
 * declaration the call runs, and post-29m75 that declaration is a symbol the
 * table holds: a function-scoped `const` arrow composes as
 * `useResolverGuards.checkGuards`, a nested `function` as `scopedTranslation.t`.
 * Before that bead the checker knew the declaration and `cg_symbols` had no row
 * for it, so this pass could not have existed.
 *
 * Resolver-side in FULL, deliberately. The walker's per-chunk channels
 * (`localBindings`, `localCallBindings`) cannot carry this evidence: on taxdome
 * 486 of the 487 rows are the `scopedTranslation` shape, whose binding sits at
 * MODULE level — outside every chunk — while the calls live inside component
 * chunks further down the file. A per-chunk record of "this name came from
 * calling that function" is dropped for exactly the dominant half of the family.
 * Scope, not chunk range, is what decides which binding a callee refers to, and
 * the checker is what knows scopes.
 *
 * PRECISION over recall, in three places:
 *
 *   - the gate is the DECLARATION shape, not the type. Every declaration of the
 *     callee must be a variable or binding element initialized from a call, so a
 *     destructured PROP (`function Row({ onRemove })`) and a plain callback
 *     parameter — both `BindingElement`/`Parameter` with no call behind them —
 *     are not this pass's business and keep falling to the honest-miss bucket
 *     bd tea-rags-mcp-5tatv put them in;
 *   - a declaration outside the project's own sources yields `continue`, so a
 *     `useState` setter or a `useTranslation` `t` stays an external call rather
 *     than becoming an edge into `node_modules`;
 *   - it NEVER degrades to a file-only edge. Where `typeCheckerFallback` emits
 *     `targetSymbolId: null` on a declaration the symbol table cannot confirm,
 *     this pass declines outright. The whole point of the family is the nested
 *     MEMBER; a file edge to the hook's module is not a weaker version of that
 *     answer, it is a different and unasked-for one.
 *
 * Chain position: head of the checker tier, right behind `jsxComponent`. Ahead
 * of it are only passes that answer this call shape correctly and for free, and
 * the cost gate is the reason it is not earlier — reaching the declaration takes
 * `getSymbolAtLocation` on the callee, which run before pass 10 would be paid on
 * every bare call the cheap passes were about to answer. Nothing is lost by
 * waiting: on taxdome every row of this family is a `missed`, never a
 * `wrongFile`, so no earlier pass is producing an answer this one would have to
 * override. It must stay AHEAD of `typeCheckerFallback`, whose `overload`
 * classification reaches the same declaration through the same call and would
 * hand back a file-only edge for the subset this pass declines.
 */

import ts from "typescript";

import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";
import { composeSymbolId, findCallExpression } from "./ts-type-checker-fallback.js";

export class TSCallResultCalleeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "callResultCallee";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
  ) {}

  /**
   * Gates run cheapest-first, and the ordering is load-bearing rather than
   * stylistic: the shape checks and the indexed call-site lookup cost nothing,
   * `getSymbolAtLocation` is a symbol resolution, and `getResolvedSignature` —
   * the expensive one — runs only once the callee has been PROVEN to be a
   * call-result binding. Inverting any two of them would pay full signature
   * resolution on every unresolved bare call in the corpus.
   */
  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return CONTINUE;

    const handle = this.programCache.acquire(ctx.callerFile);
    if (handle === null) return CONTINUE;

    const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
    if (node === null || !ts.isIdentifier(node.expression)) return CONTINUE;
    if (!calleeBoundToCallResult(handle.checker, node.expression)) return CONTINUE;

    const declaration = handle.checker.getResolvedSignature(node)?.declaration;
    if (declaration === undefined) return CONTINUE;

    const targetRelPath = this.programCache.toProjectSourceRelPath(declaration.getSourceFile().fileName);
    if (targetRelPath === null) return CONTINUE;

    const targetSymbolId = pinDeclaredSymbol(declaration, targetRelPath, ctx, this.cfg.mode);
    return targetSymbolId === null ? CONTINUE : resolved({ targetRelPath, targetSymbolId });
  }
}

/**
 * The run's symbolId for the declaration the checker selected, or `null` when
 * the table cannot confirm exactly one.
 *
 * Exact composed id first, then the declaration's short name narrowed to that
 * ONE file — the second lookup is what actually answers this family, because
 * `composeSymbolId` prefixes only enclosing `namespace` blocks and so composes a
 * nested closure as the bare `checkGuards` while the table holds it as
 * `useResolverGuards.checkGuards`. Narrowing to the file the checker named keeps
 * that from being a global short-name guess, and `pickSingleCandidate` drops the
 * file that declares the name twice.
 *
 * `composeSymbolId` is shared with `scripts/ts-codegraph-typechecker-oracle.ts`
 * rather than re-derived here on purpose: the oracle pins the checker's
 * declarations the same way, and a second implementation would make a
 * measurement disagreement indistinguishable from a real one.
 */
function pinDeclaredSymbol(
  declaration: ts.SignatureDeclaration | ts.JSDocSignature,
  targetRelPath: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): string | null {
  const composed = composeSymbolId(declaration);
  if (composed === null) return null;

  const exact = ctx.symbolTable.lookup(composed.symbolId).filter((def) => def.relPath === targetRelPath);
  if (exact.length > 0) return exact[0].symbolId;

  const inFile = ctx.symbolTable.lookupByShortName(composed.shortName).filter((def) => def.relPath === targetRelPath);
  return pickSingleCandidate(inFile, mode)?.symbolId ?? null;
}

/**
 * Is EVERY declaration of `callee` a binding initialized from a call?
 *
 * "Every", for the reason {@link isLocalValueBinding} uses it one pass over: a
 * name that is also a project declaration elsewhere in the file must not lose
 * its own resolution to one call-bound shadow.
 *
 * The question is asked of the declaration and not of the type because the type
 * of a call-bound callable is indistinguishable from the type of a prop callback
 * — both are function types — while the declarations are not: one has a
 * `CallExpression` behind it and the other has a parameter list.
 */
function calleeBoundToCallResult(checker: ts.TypeChecker, callee: ts.Identifier): boolean {
  const declarations = checker.getSymbolAtLocation(callee)?.getDeclarations() ?? [];
  return declarations.length > 0 && declarations.every(isCallResultBinding);
}

/**
 * `const x = fn(…)` or any element of `const { a } = fn(…)` / `const [a] = fn(…)`.
 *
 * A binding element is followed UP through its patterns to whatever declares
 * them, so a nested destructure resolves to the same variable its outermost
 * pattern belongs to — and a destructured PARAMETER lands on a `Parameter`
 * instead, which is precisely the shape this pass must not claim.
 */
function isCallResultBinding(declaration: ts.Declaration): boolean {
  if (ts.isVariableDeclaration(declaration)) return isCallInitializer(declaration.initializer);
  if (!ts.isBindingElement(declaration)) return false;
  const owner = declaringVariableOf(declaration);
  return owner !== null && isCallInitializer(owner.initializer);
}

/** `fn(…)`, including the `await fn(…)` a hook-shaped factory is often awaited through. */
function isCallInitializer(initializer: ts.Expression | undefined): boolean {
  if (initializer === undefined) return false;
  const unwrapped = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
  return ts.isCallExpression(unwrapped);
}

/** The `VariableDeclaration` a binding element ultimately belongs to, or `null`. */
function declaringVariableOf(element: ts.BindingElement): ts.VariableDeclaration | null {
  let cursor: ts.Node = element.parent;
  while (ts.isBindingElement(cursor) || ts.isObjectBindingPattern(cursor) || ts.isArrayBindingPattern(cursor)) {
    cursor = cursor.parent;
  }
  return ts.isVariableDeclaration(cursor) ? cursor : null;
}
