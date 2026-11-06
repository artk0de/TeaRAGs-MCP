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
import { PhpImportFileMapper } from "./php-import-file-mapper.js";
import {
  PhpGlobalShortNameSymbolResolutionStrategy,
  PhpQualifiedReceiverSymbolResolutionStrategy,
  PhpSameFileFunctionSymbolResolutionStrategy,
  PhpScopedCallSymbolResolutionStrategy,
  PhpThisMemberSymbolResolutionStrategy,
  PhpTypedReceiverSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

/**
 * PHP call resolution. Order is precedence: the first terminal outcome wins.
 *
 *   1. `thisMember` — `$this->method()` looks up `Owner#method` in the caller
 *      file. A miss drops, so a global function of the same name is not bound.
 *   2. `typedReceiver` — `$repo->save()` when the walker bound `$repo` to a
 *      type. No binding continues. A known type with no such member drops.
 *   3. `scopedCall` — `Bar::make()` in the caller file, or behind a `use`
 *      that names one project file. `self::` and `static::` use the enclosing
 *      class. An unmatched receiver continues.
 *   4. `qualifiedReceiver` — any receiver still open drops.
 *   5. `sameFileFunction` — a bare `helper()` in the caller file.
 *   6. `globalShortName` — a bare call whose short name is exactly one function.
 *
 * `resolveFileEdges` asks `PhpImportFileMapper`. A `use` the index does not
 * hold produces no edge and no synthesised path.
 */
export class PhpCallResolver implements CallResolver {
  readonly language = "php";
  private readonly strategies: SymbolResolutionStrategy[];
  private readonly mapper = new PhpImportFileMapper();

  constructor(private readonly mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: ResolverConfig = { mode };
    this.strategies = [
      new PhpThisMemberSymbolResolutionStrategy(cfg),
      new PhpTypedReceiverSymbolResolutionStrategy(cfg),
      new PhpScopedCallSymbolResolutionStrategy(cfg, this.mapper),
      new PhpQualifiedReceiverSymbolResolutionStrategy(cfg),
      new PhpSameFileFunctionSymbolResolutionStrategy(cfg),
      new PhpGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  resolveFileEdges(extraction: FileExtraction, ctx: CallContext): GraphEdges["fileEdges"] {
    return resolveImportFileEdges(extraction, this.mapper, ctx);
  }
}
