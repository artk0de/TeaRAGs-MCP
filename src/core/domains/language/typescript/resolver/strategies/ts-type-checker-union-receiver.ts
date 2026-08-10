/**
 * Union-typed and guard-narrowed receivers, resolved by asking the compiler what
 * the receiver ACTUALLY is at the call site (bd tea-rags-mcp-3yj7d).
 *
 * The TypeScript walker reads a type annotation only when it names one type:
 * `extractTypeNameFromAnnotation` returns `null` for a union, so `x: A | B`
 * produces no `LocalBinding` at all. Everything downstream inherits that blind
 * spot — no `localBinding` means the CHA cone has no base type to expand and the
 * tree-sitter passes have nothing to match on, so `x.process()` either misses
 * outright or gets pinned by a short-name guess that happens to land.
 *
 * `checker.getTypeAtLocation` sees what tree-sitter cannot, and it sees it
 * FLOW-SENSITIVELY — which is what makes one pass cover both halves of the case:
 *
 *   - Unnarrowed, the receiver's type is still the union. Every branch is a
 *     live dispatch target, so the call fans out to all of them as `cone` edges
 *     sharing unit weight (`confidence = 1/N`), the same devirtualization
 *     bookkeeping {@link ConeDispatchResolver} does for CHA subtypes and
 *     `RubyUnionDispatchResolver` does for YARD `[A, B]` annotations.
 *   - Narrowed by `typeof` / `instanceof` / a discriminant test, the type at the
 *     call site has already collapsed to one branch. That is not a fan-out at
 *     all: the compiler proved the receiver, so it earns a single `exact` edge.
 *
 * **Why this is a dispatch component and not a chain pass.** A
 * `SymbolResolutionStrategy` returns ONE `SymbolResolutionTarget`; it is
 * structurally unable to express N cone edges with a confidence split, and
 * `MethodEdgeKind` is not part of that contract either. `resolveDispatch` is the
 * seam that carries both, and `CallEdgeResolutionRunner` consults it BEFORE the
 * strategy chain — so a union receiver is decided by the checker rather than by
 * a heuristic pass that would otherwise pick a same-file or short-name
 * homonym.
 *
 * That precedence is deliberately narrow. The component declines unless the
 * receiver's DECLARED type is a union, which is exactly the population the
 * tree-sitter chain provably has no type binding for. Every other call shape
 * returns `[]` and the chain runs untouched.
 *
 * Precision over recall throughout, mirroring the sibling type-checker pass:
 * a branch's declaration becomes an edge only after the run's
 * `GlobalSymbolTable` confirms it, and a declaration outside the project
 * (`node_modules`, the default lib) is skipped so the external classifier keeps
 * its bucket. `CODEGRAPH_TS_TYPECHECKER=0` removes the component entirely —
 * it is only constructed when the shared {@link TSProgramCache} exists.
 */

import type ts from "typescript";

import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type MethodEdgeKind,
  type RelPath,
  type SymbolId,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import { CONE_MAX_DEFAULT, type ResolverConfig } from "./shared.js";
import { declarationOwnerName, findReceiverExpression } from "./ts-type-checker-shared.js";

/**
 * A branch's member pinned to a concrete symbol. Narrower than
 * `SymbolResolutionTarget` on purpose: the edge store discards method edges
 * with a null `targetSymbolId`, so a file-only pin is not a fan-out candidate
 * at all and the type says so rather than leaving a branch to check.
 */
interface PinnedBranchTarget {
  targetRelPath: RelPath;
  targetSymbolId: SymbolId;
}

export class TSTypeCheckerUnionReceiverDispatchResolver implements DispatchResolverComponent {
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache,
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    return { kind: "edges", edges: this.resolveDispatchEdges(call, ctx) };
  }

  /**
   * Both halves of the case share one type query, so they share one method: the
   * shape of `getTypeAtLocation`'s answer is what separates a fan-out from a
   * narrowed pin.
   */
  private resolveDispatchEdges(call: CallRef, ctx: CallContext): DispatchEdge[] {
    // Cheapest gate first — a bare call has no receiver to type, and declining
    // here keeps the Program unbuilt.
    if (call.receiver === null || call.receiver.length === 0) return [];

    const handle = this.programCache.acquire(ctx.callerFile);
    if (!handle) return [];

    const receiver = findReceiverExpression(handle.sourceFile, call.startLine, call.member);
    if (!receiver) return [];

    const { checker } = handle;
    const branches = unionBranches(checker.getTypeAtLocation(receiver));

    if (branches.length >= 2) return this.fanOut(branches, call.member, ctx);
    // One type at the call site is only interesting when the DECLARED type was a
    // union — that is a guard having done its work. A receiver declared as a
    // single type is not this component's case at all.
    if (!declaredTypeIsUnion(receiver, checker)) return [];
    return this.pinNarrowed(checker.getTypeAtLocation(receiver), call.member, ctx);
  }

  /**
   * Every branch that still declares the member is a live dispatch target, so
   * each gets a `cone` edge and they split unit weight.
   *
   * `N` counts the CONFIRMED in-project targets, not the union's arity: a branch
   * resolving into `node_modules` or the default lib contributes no edge, and a
   * branch the symbol table cannot confirm contributes no edge either. This
   * matches `RubyUnionDispatchResolver` and `ConeDispatchResolver`, both of
   * which divide by the number of edges they actually emit.
   *
   * Above the cone cap the answer is `[]`, not a `poly-base` edge: a union has
   * no single base declaration to collapse onto, so there is nothing honest to
   * point one edge at. The chain then resolves the call as it did before.
   */
  private fanOut(branches: readonly ts.Type[], member: string, ctx: CallContext): DispatchEdge[] {
    const targets = this.pinBranches(branches, member, ctx);
    if (targets.length === 0) return [];
    if (targets.length > (this.cfg.coneMax ?? CONE_MAX_DEFAULT)) return [];

    const confidence = 1 / targets.length;
    return targets.map((target) => toEdge(target, "cone", confidence));
  }

  /** The guard proved one branch, so the edge is as certain as any `exact` one. */
  private pinNarrowed(branch: ts.Type, member: string, ctx: CallContext): DispatchEdge[] {
    const targets = this.pinBranches([branch], member, ctx);
    return targets.length === 1 ? [toEdge(targets[0], "exact", 1)] : [];
  }

  /**
   * Confirmed method targets across `branches`, deduplicated by symbolId —
   * branches that inherit one declaration (`A` and `B extends A`) name the same
   * method and must not double-count against the confidence split.
   */
  private pinBranches(branches: readonly ts.Type[], member: string, ctx: CallContext): PinnedBranchTarget[] {
    const targets: PinnedBranchTarget[] = [];
    const seen = new Set<string>();

    for (const branch of branches) {
      const target = this.pinMember(branch, member, ctx);
      if (target === null) continue;
      if (seen.has(target.targetSymbolId)) continue;
      seen.add(target.targetSymbolId);
      targets.push(target);
    }
    return targets;
  }

  /**
   * The member as declared on one branch, confirmed against the run's symbol
   * table — the vocabulary every other edge is phrased in.
   *
   * The declaration supplies the file AND the owning class, and the owner is
   * what makes the confirmation exact: an inherited member declares on the
   * ANCESTOR, so pinning by owner rather than by branch name is what lets
   * `B extends A` resolve to `A#process` instead of inventing `B#process`.
   * Failing confirmation the branch is dropped — a file-only fan-out edge would
   * be discarded by the edge store anyway, and a guessed id would be a
   * fabricated target.
   */
  private pinMember(branch: ts.Type, member: string, ctx: CallContext): PinnedBranchTarget | null {
    const declaration = branch.getProperty(member)?.declarations?.[0];
    if (!declaration) return null;

    const targetRelPath = this.programCache.toRelPath(declaration.getSourceFile().fileName);
    if (targetRelPath === null) return null;

    const ownerName = declarationOwnerName(declaration);
    const candidates = ctx.symbolTable
      .lookupByShortName(member)
      .filter((def) => def.relPath === targetRelPath && (ownerName === null || def.scope.at(-1) === ownerName));

    const hit = pickSingleCandidate(candidates, this.cfg.mode);
    return hit ? { targetRelPath: hit.relPath, targetSymbolId: hit.symbolId } : null;
  }
}

/** Fan-out edges originate at the caller chunk, which the runner fills in. */
function toEdge(target: PinnedBranchTarget, edgeKind: MethodEdgeKind, confidence: number): DispatchEdge {
  return {
    sourceSymbolId: null,
    targetRelPath: target.targetRelPath,
    targetSymbolId: target.targetSymbolId,
    edgeKind,
    confidence,
  };
}

/** Constituents of a union type; `[]` for everything else. */
function unionBranches(type: ts.Type): readonly ts.Type[] {
  return type.isUnion() ? type.types : [];
}

/**
 * Was the receiver DECLARED as a union, whatever it narrowed to here?
 *
 * Asking for the type at the symbol's own declaration deliberately steps
 * outside the call site's control-flow graph, which is the only way to tell
 * "narrowed from `A | B` to `A`" apart from "was always `A`". A receiver with no
 * symbol (the result of a call, an index access) has no declaration to consult
 * and is treated as not-declared-union — the unnarrowed path already covers it
 * when its type is a union.
 */
function declaredTypeIsUnion(receiver: ts.Expression, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(receiver);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration) return false;
  return checker.getTypeOfSymbolAtLocation(symbol, declaration).isUnion();
}
