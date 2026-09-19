import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupEcmascriptSymbolsByShortName } from "../../../shared/ecmascript-symbol-lookup.js";
import { targetsExternalImport } from "../ts-external-call.js";
import { checkerDeclaresCalleeIn, importBoundProjectFile } from "../ts-import-bound-callee.js";
import { interfaceReceiverExcludesCandidate } from "../ts-interface-receiver.js";
import { calleeIsLocalValueBinding } from "../ts-local-callee.js";
import { receiverBoundToProjectType, receiverIsUnpinnableLocalValueBinding } from "../ts-local-receiver.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import { memberCandidateLacksReceiverEvidence } from "../ts-receiver-member-evidence.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Global short-name lookup — handles default exports, ambient declarations, and
 * free calls. `pickSingleCandidate(mode)` returns the sole hit (strict) or the
 * first hit (legacy `first` mode). On a non-decisive result (no candidates, or
 * ambiguous under strict mode) continue to the import-narrowed fallback.
 *
 * The lookup key is a BARE member name, which is what makes the external guard
 * load-bearing rather than a nicety (bd tea-rags-mcp-6b3gj): `arr.push()` and
 * `console.error()` carry a member that some project symbol is very likely to
 * share, and matching it here emits an edge to code the call never reaches.
 * A call that provably leaves the project CONTINUEs instead — the later
 * type-checker passes still get their turn, and a call none of them can answer
 * ends up correctly classified external rather than silently fabricated.
 *
 * A BARE call needs a second guard, because every arm of the external one
 * inspects a receiver and a free call has none (bd tea-rags-mcp-5tatv). There
 * the member IS the callee identifier, so `onRemove(attachment)` matched an
 * unrelated `Tooltip#onRemove` — see {@link calleeIsLocalValueBinding} for why a
 * destructured prop or a hook's returned setter was invisible to the chain. It
 * stays a separate predicate rather than a fifth case of the external one: those
 * calls are not external, they are simply unpinnable, and the two verdicts feed
 * different denominators.
 *
 * A DISPATCHING call needs the receiver twin of that guard, for the half the
 * external one declines to answer (bd tea-rags-mcp-z0zqd). Its checker arm
 * decides every receiver whose type resolves outside the project, but says
 * nothing about one with no resolvable type at all — an unannotated destructured
 * parameter, an `any`-returning hook — because it may only ever ADD an external
 * verdict. {@link receiverIsUnpinnableLocalValueBinding} decides those on the
 * DECLARATION instead, and only when the checker also names no in-project type,
 * so a destructured receiver holding a real project instance keeps its edge.
 *
 * A receiver the walker ALREADY typed needs the fourth guard, and that one is
 * about chain order rather than about the receiver (bd tea-rags-mcp-dubkx).
 * `localBinding` at position 4 owns the walker-typed receiver and looks the
 * member up under that type; a call arriving here carries its negative answer,
 * so the receiver-blind short-name match this pass would commit is a naming
 * coincidence. See {@link receiverBoundToProjectType} for the measurement and
 * for why the guard stops at this pass rather than travelling to 10.
 * A BARE call the caller IMPORTED is decided by the import, not by the index
 * (bd tea-rags-mcp-d0xpr). Strict mode's ambiguity refusal only fires at N>1,
 * and the measured defect is at N=1: taxdome's prototype galleries each own a
 * `tableHelpers.ts` exporting `getRenderableContent = memoize(renderContent)`,
 * which the walker does not name, so the only INDEXED symbol of that name sits
 * in an unrelated `react-app` helper and every gallery's call landed on it. See
 * {@link importBoundProjectFile} for why the import is authoritative and why the
 * check is scoped to calls with no receiver.
 *
 * A receiver the checker types as a PROJECT INTERFACE is decided by that
 * interface, never by how many methods share the member's name (bd
 * tea-rags-mcp-hwwtw). `walkCommits`'s destructured `diffMemo?.set(...)` landed
 * on `CommitDiffMemo#set` only while `set` was unique, and lost every edge when
 * `RunScopedMemo#set` appeared. The implementers are reached by
 * `TSTypeCheckerInterfaceReceiverDispatchResolver`, which runs before the chain,
 * so here the unique match is kept only when its owner is one of those
 * interfaces or a class the hierarchy records implementing one. See
 * {@link interfaceReceiverExcludesCandidate} for the rule and for why a
 * structural implementer with no `implements` clause is not accepted on name.
 *
 * Any OTHER receiver the walker did not type needs the checker's agreement —
 * with no Program, an import binding's — not just a unique name (bd
 * tea-rags-mcp-t5cji): see
 * {@link memberCandidateLacksReceiverEvidence}. Once the family filter stopped
 * Ruby namesakes from making `title` / `filter` / `request` ambiguous, this
 * pass committed `COPY.title(...)` on an object literal to the project's lone
 * `Message#title`. A bare call is exempt — its name IS the callee.
 *
 * The guard reads the resolver's `TSProgramCache` when one exists (bd
 * tea-rags-mcp-335eu), which is what lets it decline a receiver only the checker
 * could type — `const map = readRegistry(); map.set(k, v)`. The cache arrives as
 * its own constructor argument rather than through {@link ResolverConfig}, for
 * the same reason passes 11-14 take it that way: `ResolverConfig` is the
 * compiler-free config every strategy shares, and the cache is `null` whenever
 * `CODEGRAPH_TS_TYPECHECKER=0` removed the checker tier.
 */
export class TSGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(
    private readonly cfg: ResolverConfig,
    private readonly programCache: TSProgramCache | null = null,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (receiverBoundToProjectType(call, ctx)) return CONTINUE;
    if (targetsExternalImport(call, ctx, this.cfg.tsOptions, this.programCache, this.cfg.fileExists)) return CONTINUE;
    if (calleeIsLocalValueBinding(call, ctx, this.programCache)) return CONTINUE;
    if (receiverIsUnpinnableLocalValueBinding(call, ctx, this.programCache)) return CONTINUE;
    const fallback = lookupEcmascriptSymbolsByShortName(ctx, call.member);
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (!hit) return CONTINUE;
    // After the pick, so the checker is asked only when a match would commit.
    if (interfaceReceiverExcludesCandidate(call, ctx, this.programCache, hit)) return CONTINUE;
    if (memberCandidateLacksReceiverEvidence(call, ctx, this.cfg, this.programCache, hit)) return CONTINUE;
    if (this.importContradictsCandidate(call, ctx, hit.relPath)) return CONTINUE;
    return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
  }

  /**
   * Does the caller's own import say this candidate is the wrong FILE
   * (bd tea-rags-mcp-d0xpr)?
   *
   * Cheap half first, and it is the one that keeps the checker out of the
   * resolving path: an import that binds the bare callee to the candidate's own
   * file — or no such import at all — agrees, and nothing more is asked. Only a
   * DISAGREEMENT is worth a checker query, and only the checker can read it,
   * since a barrel re-export and a same-name coincidence look identical to the
   * symbol table.
   */
  private importContradictsCandidate(call: CallRef, ctx: CallContext, candidateFile: string): boolean {
    const boundFile = importBoundProjectFile(call, ctx, this.cfg.tsOptions, this.cfg.fileExists);
    if (boundFile === null || boundFile === candidateFile) return false;
    const declaredIn = checkerDeclaresCalleeIn(call, ctx, this.programCache);
    return declaredIn !== null && declaredIn !== candidateFile;
  }
}
