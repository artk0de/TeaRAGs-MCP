/**
 * Cross-call return-type inference — type a receiver from the return type of
 * the call that produced it (bd tea-rags-mcp-l3uob).
 *
 * ```ts
 * const x = makeFoo();   // no annotation here …
 * x.method();            // … and none here either
 * ```
 *
 * Every tree-sitter pass ahead of this one keys off an explicit `: Type`
 * somewhere: `fieldType` reads a declared class field, `localBinding` reads what
 * the walker bound from an annotation. Here there is nothing to read — `x`'s
 * type exists ONLY as the return type the compiler inferred for `makeFoo`, and
 * the passes that decline this call decline it correctly. `globalShortName`
 * would resolve it whenever the member name happens to be unique in the repo,
 * but that is cardinality luck, not type knowledge; the moment two classes share
 * the member name, strict mode drops the call and the edge is simply lost.
 *
 * The checker already computed that inferred type while building the Program.
 * This pass only READS it: receiver identifier → its declaration → the
 * declaration's type → the member on that type. `getPropertyOfType` walks the
 * inheritance chain, so an inherited member resolves to the file the base class
 * lives in rather than to the derived class the receiver happens to name.
 *
 * **Ordered ahead of `typeCheckerFallback`, behind everything cheaper.** Both
 * checker passes share ONE {@link TSProgramCache}, so between them the cost is
 * identical and only precision decides the order. The signature route
 * (`getResolvedSignature`) answers a superset of call shapes but pins only the
 * declaration a signature belongs to; the receiver-type route pins the receiver
 * TYPE first and reads the member off it, which is the more specific evidence
 * for exactly the shape this pass gates on. Behind the fallback this pass would
 * be dead code — the fallback already answers every ambiguous-member call it
 * would ever see.
 *
 * Precision over recall, same discipline as its sibling: the gate rejects every
 * receiver shape another pass owns (annotated declarations, `this.field`,
 * destructuring, ambient globals), a member declaration outside the project
 * yields `continue`, and a checker answer is turned into an edge only after the
 * run's `GlobalSymbolTable` confirms it. `CODEGRAPH_TS_TYPECHECKER=0` removes
 * the whole checker tier.
 *
 * The gate deliberately does NOT require the member name to be indexed already.
 * Requiring it would make this pass a strict subset of `typeCheckerFallback`
 * under `strict` mode — a call reaching the checker tier at all has either zero
 * or ≥2 same-named definitions, and the ≥2 half is exactly what the fallback's
 * `overload` classification claims. The zero half is where a receiver-typed
 * answer is the ONLY answer available: the checker names the declaring file for
 * a member the chunker never recorded as a symbol (a `.d.ts` declaration, an
 * interface member, an object-literal method), and the contract's null
 * `targetSymbolId` exists precisely for "the file is certain, the member is
 * not". The cost is one Program per caller file that reaches this pass, which
 * the shared cache already amortizes across both checker passes.
 *
 * NOTE — the symbolId MECHANICS (`memberSeparator`, `prefixWithNamespaces`) now
 * come from `./ts-type-checker-shared.js`; they were duplicated across the
 * checker passes only while those passes were being authored on parallel
 * branches (bd tea-rags-mcp-un8mv). `composeMemberSymbolId` stays local because
 * it is not the same function as the fallback's `composeSymbolId`: it takes the
 * member name from the CALL rather than deriving it from the declaration, and it
 * declines an owner it cannot name where the fallback degrades to a bare short
 * name. Same mechanics, different contract.
 */

import ts from "typescript";

import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { ECMASCRIPT_GLOBALS } from "../../../shared/ecmascript-globals.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";
import { memberSeparator, prefixWithNamespaces } from "./ts-type-checker-shared.js";

export class TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "typeCheckerReturnType";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!isUntypedLocalReceiver(call, ctx)) return CONTINUE;

    const handle = this.programCache.acquire(ctx.callerFile);
    if (!handle) return CONTINUE;

    const receiverNode = findReceiverIdentifier(handle.sourceFile, call);
    if (!receiverNode) return CONTINUE;

    const declaration = callInitializedDeclarationOf(handle.checker, receiverNode);
    if (!declaration) return CONTINUE;

    const memberDeclaration = this.memberOfInferredType(handle.checker, declaration, call.member);
    if (!memberDeclaration) return CONTINUE;

    const targetRelPath = this.programCache.toRelPath(memberDeclaration.getSourceFile().fileName);
    if (targetRelPath === null) return CONTINUE;

    return resolved({
      targetRelPath,
      targetSymbolId: this.pinSymbol(memberDeclaration, call.member, targetRelPath, ctx),
    });
  }

  /**
   * The declaration of `member` on the type the checker inferred for
   * `declaration`. `getPropertyOfType` resolves through the inheritance chain,
   * so a member declared on a base class reports the BASE class's declaration —
   * the file that actually holds the code the call reaches.
   *
   * A union receiver (`Foo | Bar`) yields a synthesized property carrying one
   * declaration per constituent. Spanning more than one file is genuine
   * ambiguity, dropped under `strict` exactly as `pickSingleCandidate` drops an
   * ambiguous symbol-table lookup; several declarations in ONE file are
   * overloads of the same member and compose to the same edge either way.
   */
  private memberOfInferredType(
    checker: ts.TypeChecker,
    declaration: CallInitializedVariable,
    member: string,
  ): ts.Declaration | null {
    const type = checker.getTypeAtLocation(declaration.name);
    const declarations = checker.getPropertyOfType(type, member)?.declarations;
    if (declarations === undefined || declarations.length === 0) return null;
    const files = new Set(declarations.map((decl) => decl.getSourceFile().fileName));
    if (files.size > 1 && this.cfg.mode === "strict") return null;
    return declarations[0];
  }

  /**
   * Confirm the checker's member declaration against the run's symbol table,
   * which is the vocabulary every other edge is phrased in. Exact composed id
   * first; then the member's short name narrowed to that one file — which
   * recovers the cases where the chunker composed the id differently. Failing
   * both, the FILE is still certain from a real type resolution, so a file-only
   * edge is emitted rather than nothing.
   */
  private pinSymbol(
    declaration: ts.Declaration,
    member: string,
    targetRelPath: string,
    ctx: CallContext,
  ): string | null {
    const composed = composeMemberSymbolId(declaration, member);
    if (composed !== null) {
      const exact = ctx.symbolTable.lookup(composed).filter((def) => def.relPath === targetRelPath);
      if (exact.length > 0) return exact[0].symbolId;
    }
    const byShortName = ctx.symbolTable.lookupByShortName(member).filter((def) => def.relPath === targetRelPath);
    return pickSingleCandidate(byShortName, this.cfg.mode)?.symbolId ?? null;
  }
}

/** A `const`/`let` whose type comes from an initializing call and nowhere else. */
type CallInitializedVariable = ts.VariableDeclaration & { name: ts.Identifier };

/**
 * Is this a bare local receiver no cheaper pass could have typed?
 *
 * Pure and cheap — it reads the call shape and the walker's bindings, never the
 * file system, so the common receivers (`this.field`, an ambient global, a
 * walker-bound parameter) cost nothing to reject. A receiver the walker DID
 * bind belongs to `localBinding`; re-answering it here would override a cheaper
 * decision on the same evidence.
 */
function isUntypedLocalReceiver(call: CallRef, ctx: CallContext): boolean {
  const { receiver } = call;
  if (receiver === null || receiver.length === 0) return false;
  if (receiver.includes(".") || receiver === "this" || receiver === "super") return false;
  if (ECMASCRIPT_GLOBALS.has(receiver)) return false;
  return resolveLocalBindingType(ctx.localBindings, receiver, call.startLine) === undefined;
}

/**
 * The receiver identifier of the call `member` on `receiver` starting at
 * `startLine` (1-based, matching `CallRef.startLine`). Both coordinates are
 * checked because one line routinely holds several calls — matching on the line
 * alone would type a neighbour's receiver and emit its target.
 */
function findReceiverIdentifier(sourceFile: ts.SourceFile, call: CallRef): ts.Identifier | null {
  let found: ts.Identifier | null = null;

  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    const receiver = callReceiverIdentifier(node, call);
    if (
      receiver !== null &&
      sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 === call.startLine
    ) {
      found = receiver;
      return;
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

/** `x` in `x.member(…)`, when `node` is that exact call. `null` for anything else. */
function callReceiverIdentifier(node: ts.Node, call: CallRef): ts.Identifier | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!ts.isIdentifier(callee.name) || callee.name.text !== call.member) return null;
  if (!ts.isIdentifier(callee.expression) || callee.expression.text !== call.receiver) return null;
  return callee.expression;
}

/**
 * The variable declaration `receiver` binds to, but only when its type can come
 * from nowhere except the initializing call: a plain identifier name (a
 * destructuring pattern binds a member of the result, not the result), no type
 * annotation (an annotated declaration is the tree-sitter passes' case), and a
 * call initializer — optionally awaited, since an async factory returns its
 * value through a Promise and is the same inference either way.
 *
 * Resolution goes through `getSymbolAtLocation` rather than a name scan so
 * shadowing is handled by the compiler's own scope analysis.
 */
function callInitializedDeclarationOf(
  checker: ts.TypeChecker,
  receiver: ts.Identifier,
): CallInitializedVariable | null {
  const declaration = checker.getSymbolAtLocation(receiver)?.valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return null;
  if (!ts.isIdentifier(declaration.name)) return null;
  if (declaration.type !== undefined) return null;
  const { initializer } = declaration;
  if (initializer === undefined) return null;
  const unwrapped = ts.isAwaitExpression(initializer) ? initializer.expression : initializer;
  return ts.isCallExpression(unwrapped) ? (declaration as CallInitializedVariable) : null;
}

/**
 * Project symbolId for `member` declared on `declaration`'s owner, per
 * `.claude/rules/symbolid-convention.md`: `Owner#member` for instance members,
 * `Owner.member` for static ones, dotted namespace prefixes for anything nested
 * in a `namespace` / `module` block.
 *
 * Returns `null` when the owner has no stable name (an object-literal type, an
 * anonymous class expression) — the caller then narrows by short name rather
 * than inventing an id.
 */
function composeMemberSymbolId(declaration: ts.Declaration, member: string): string | null {
  const owner = declaration.parent;
  if (!ts.isClassLike(owner) && !ts.isInterfaceDeclaration(owner)) return null;
  const ownerName = owner.name?.text;
  if (ownerName === undefined) return null;
  return `${prefixWithNamespaces(owner, ownerName)}${memberSeparator(declaration)}${member}`;
}
