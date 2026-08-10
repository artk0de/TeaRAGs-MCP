/**
 * Last pass of the TypeScript resolution chain: ask the real compiler
 * (bd tea-rags-mcp-uclbn).
 *
 * The ten passes ahead of it read tree-sitter shapes — imports, class fields,
 * walker-bound locals, short names. That covers most calls and costs nothing.
 * What it cannot cover is any call whose target depends on TYPE information:
 * a receiver typed only by inference through a generic factory, a member name
 * declared on several classes where `strict` mode correctly refuses to guess,
 * an explicitly-instantiated generic. For those, `getResolvedSignature` gives
 * the one answer no amount of AST pattern-matching produces — the concrete
 * signature the compiler itself selected, and with it the declaration that
 * signature belongs to.
 *
 * It runs LAST and only on calls every earlier pass declined, so it never
 * overrides a cheaper decision, and it is gated twice more before spending
 * anything: {@link classifyTypeCheckerFallbackCase} rejects call shapes the
 * checker could not improve on (a plain unresolved call is usually dynamic, not
 * generic), and the Program itself is built lazily per file by
 * {@link TSProgramCache}.
 *
 * Precision over recall throughout. The checker's declaration is only turned
 * into an edge after the run's `GlobalSymbolTable` confirms it — the symbol
 * table is what the rest of the graph is phrased in, and a target it has never
 * heard of would be a fabricated edge. A declaration outside the project
 * (`node_modules`, the default lib) yields `continue`, leaving the external
 * classifier to bucket the call as it does for every other external call.
 */

import ts from "typescript";

import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { INSTANCE_METHOD_SEPARATOR } from "../../../../../infra/symbolid/index.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Why a call site is worth a type check.
 *
 *   - `generic`  — the call site instantiates type parameters explicitly
 *     (`decode<Config>(raw)`). The written type arguments are exactly the
 *     information tree-sitter records but cannot act on.
 *   - `overload` — the member is declared on two or more project types, which
 *     is the ambiguity `strict` mode drops. The checker knows which one the
 *     receiver actually is.
 */
export type TSTypeCheckerFallbackCase = "generic" | "overload";

/** TypeScript joins namespaces and static members with a dot. */
const TS_SCOPE_SEPARATOR = ".";

/**
 * Decide whether a call the tree-sitter chain declined is worth a type check,
 * or is simply unresolvable. Pure and cheap — it reads the call text and the
 * symbol table's short-name cardinality, never the file system.
 *
 * `generic` outranks `overload` because it is the more specific signal: an
 * explicitly-instantiated call names its types at the call site regardless of
 * how many definitions share the member name.
 */
export function classifyTypeCheckerFallbackCase(call: CallRef, ctx: CallContext): TSTypeCheckerFallbackCase | null {
  if (hasExplicitTypeArguments(call.callText, call.member)) return "generic";
  if (ctx.symbolTable.lookupByShortName(call.member).length >= 2) return "overload";
  return null;
}

export class TSTypeCheckerFallbackSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "typeCheckerFallback";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (classifyTypeCheckerFallbackCase(call, ctx) === null) return CONTINUE;

    const handle = this.programCache.acquire(ctx.callerFile);
    if (!handle) return CONTINUE;

    const node = findCallExpression(handle.sourceFile, call.startLine, call.member);
    if (!node) return CONTINUE;

    const declaration = handle.checker.getResolvedSignature(node)?.declaration;
    if (!declaration) return CONTINUE;

    const targetRelPath = this.programCache.toRelPath(declaration.getSourceFile().fileName);
    if (targetRelPath === null) return CONTINUE;

    return resolved({ targetRelPath, targetSymbolId: this.pinSymbol(declaration, targetRelPath, ctx) });
  }

  /**
   * Confirm the checker's declaration against the run's symbol table, which is
   * the vocabulary every other edge is phrased in. Exact composed id first;
   * then the declaration's short name narrowed to that one file — which
   * recovers the cases where the chunker composed the id differently (an
   * overload signature it skipped, a nesting shape it flattened). Failing both,
   * the FILE is still known from a real type resolution, so a file-only edge is
   * emitted rather than nothing: the contract allows a null `targetSymbolId`
   * precisely for "the file is certain, the member is not".
   */
  private pinSymbol(declaration: ResolvedSignatureDeclaration, targetRelPath: string, ctx: CallContext): string | null {
    const composed = composeSymbolId(declaration);
    if (composed === null) return null;

    const exact = ctx.symbolTable.lookup(composed.symbolId).filter((def) => def.relPath === targetRelPath);
    if (exact.length > 0) return exact[0].symbolId;

    const byShortName = ctx.symbolTable
      .lookupByShortName(composed.shortName)
      .filter((def) => def.relPath === targetRelPath);
    return pickSingleCandidate(byShortName, this.cfg.mode)?.symbolId ?? null;
  }
}

/** Composed project symbolId for a declaration, plus its bare short name. */
export interface ComposedDeclarationSymbol {
  symbolId: string;
  shortName: string;
}

/**
 * What `ts.Signature.declaration` can be. The JSDoc arm appears for JS files
 * whose types come from `@param` tags; it carries no name, so it composes to no
 * symbolId and the call degrades to a file-only edge.
 */
type ResolvedSignatureDeclaration = ts.SignatureDeclaration | ts.JSDocSignature;

/**
 * Compose the project symbolId for the declaration the checker selected, per
 * `.claude/rules/symbolid-convention.md`: `Owner#member` for instance methods,
 * `Owner.member` for static ones, dotted namespace prefixes for everything
 * nested in a `namespace` / `module` block.
 *
 * Returns `null` for declaration shapes with no stable name (an inline callback,
 * a call signature) — the caller then degrades to a file-only edge instead of
 * inventing an id.
 *
 * Exported for `scripts/ts-codegraph-typechecker-oracle.ts`, which pins the
 * checker's declarations the same way this strategy does. A hand-copied second
 * implementation would drift, and a symbol-level disagreement caused by drift
 * is indistinguishable in the report from a real one.
 */
export function composeSymbolId(declaration: ResolvedSignatureDeclaration): ComposedDeclarationSymbol | null {
  if (ts.isJSDocSignature(declaration)) return null;
  const shortName = declarationShortName(declaration);
  if (shortName === null) return null;

  const owner = declaration.parent;
  if (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) {
    const ownerName = owner.name?.text;
    if (ownerName === undefined) return { symbolId: shortName, shortName };
    const separator = memberSeparator(declaration);
    return { symbolId: `${prefixWithNamespaces(owner, ownerName)}${separator}${shortName}`, shortName };
  }
  return { symbolId: prefixWithNamespaces(declaration, shortName), shortName };
}

/** `#` for instance members, `.` for `static` ones — the universal convention. */
function memberSeparator(declaration: ts.SignatureDeclaration): string {
  const isStatic = ts.canHaveModifiers(declaration)
    ? (ts.getModifiers(declaration)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword) ?? false)
    : false;
  return isStatic ? TS_SCOPE_SEPARATOR : INSTANCE_METHOD_SEPARATOR;
}

/**
 * The declaration's own name. A constructor is named `constructor` (matching
 * the synthetic the walker emits for classes without an explicit one); a
 * function expression or arrow assigned to a variable takes the variable's
 * name, which is how most TS callbacks and factories are declared.
 */
function declarationShortName(declaration: ts.SignatureDeclaration): string | null {
  if (ts.isConstructorDeclaration(declaration)) return "constructor";
  const { name } = declaration;
  if (name !== undefined && ts.isIdentifier(name)) return name.text;
  const { parent } = declaration;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return null;
}

/** Prepend the enclosing `namespace` / `module` names, outermost first. */
function prefixWithNamespaces(node: ts.Node, name: string): string {
  const scopes: string[] = [];
  let cursor: ts.Node | undefined = node.parent;
  while (cursor !== undefined) {
    if (ts.isModuleDeclaration(cursor) && ts.isIdentifier(cursor.name)) scopes.unshift(cursor.name.text);
    cursor = cursor.parent;
  }
  return scopes.length === 0 ? name : `${scopes.join(TS_SCOPE_SEPARATOR)}${TS_SCOPE_SEPARATOR}${name}`;
}

/**
 * The first call expression starting on `startLine` (1-based, matching
 * `CallRef.startLine`) whose callee's own name is `member`. Both coordinates
 * are checked because one line routinely holds several calls — matching on the
 * line alone would type-check a neighbour and emit its target.
 *
 * Exported for `scripts/ts-codegraph-typechecker-oracle.ts` so both sides of
 * that harness's diff type-check the SAME node — a differently-written finder
 * would score the two answers against different call expressions.
 */
export function findCallExpression(
  sourceFile: ts.SourceFile,
  startLine: number,
  member: string,
): ts.CallExpression | null {
  let found: ts.CallExpression | null = null;

  const visit = (node: ts.Node): void => {
    if (found !== null) return;
    if (ts.isCallExpression(node) && calleeName(node) === member) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      if (line === startLine) {
        found = node;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return found;
}

/** Rightmost identifier of a callee — `fetch` in `repo.fetch(…)`, `run` in `run(…)`. */
function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return null;
}

/**
 * Does the call site write its type arguments out — `decode<Config>(raw)`?
 *
 * The match is anchored on the member name and requires the `(` immediately
 * after the closing `>`, so a comparison that merely contains `<` (`count <
 * limit && run(x)`) is not mistaken for an instantiation. One level of nesting
 * is allowed (`load<Map<string, User>>(raw)`); deeper nesting simply misses the
 * `generic` classification and falls through to the ambiguity check, which is
 * the safe direction — a missed classification costs recall, a wrong one costs
 * a Program build.
 */
function hasExplicitTypeArguments(callText: string, member: string): boolean {
  const escaped = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const typeArgs = String.raw`<[^()<>]*(?:<[^()<>]*>[^()<>]*)*>`;
  return new RegExp(String.raw`(?:^|[^\w$])${escaped}\s*${typeArgs}\s*\(`).test(callText);
}
