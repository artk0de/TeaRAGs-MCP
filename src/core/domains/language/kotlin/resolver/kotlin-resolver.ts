/**
 * Kotlin call resolution. Order is precedence: the first pass that resolves
 * wins, and a pass that does not apply continues.
 *
 *   1. `thisMember` — `this.method()` inside a type, same file. Tries
 *      `Owner#member` (instance) then `Owner.member` (companion). A labelled
 *      `this@Outer` or a chain is not this pass.
 *   2. `typedReceiver` — `repo.save()` / `this.repo.save()` when the walker
 *      bound that name to a type in this file. The member must be in the
 *      index. An unknown type resolves to null.
 *   3. `enclosingBareCall` — bare `paint()` inside a type. A member shadows a
 *      file-level function of the same name. On a miss, continue.
 *   4. `sameFileFunction` — bare call whose id is the function's own name in
 *      this file. Another file's function is not a candidate.
 *
 * There is no project-wide short-name tail and no extension-receiver pass.
 * File edges come from `KotlinImportFileMapper`, not from synthesised calls.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type FileExtraction,
  type GraphEdges,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveImportFileEdges, resolveViaChain } from "../../kernel/index.js";
import { KotlinImportFileMapper } from "./kotlin-import-file-mapper.js";
import {
  KotlinEnclosingBareCallSymbolResolutionStrategy,
  KotlinSameFileFunctionSymbolResolutionStrategy,
  KotlinThisMemberSymbolResolutionStrategy,
  KotlinTypedReceiverSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

export class KotlinCallResolver implements CallResolver {
  readonly language = "kotlin";
  private readonly importFileMapper = new KotlinImportFileMapper();
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new KotlinThisMemberSymbolResolutionStrategy(cfg),
      new KotlinTypedReceiverSymbolResolutionStrategy(cfg),
      new KotlinEnclosingBareCallSymbolResolutionStrategy(cfg),
      new KotlinSameFileFunctionSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  resolveFileEdges(extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] {
    return resolveImportFileEdges(extraction, this.importFileMapper, ctx);
  }
}
