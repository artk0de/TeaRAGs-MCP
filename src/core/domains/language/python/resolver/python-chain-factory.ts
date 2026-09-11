/**
 * The ONE place the Python resolution chain is composed (bd tea-rags-mcp-3yxmy).
 *
 * `PythonCallResolver` used to build the array inline and both offline
 * harnesses — `scripts/codegraph-chain-tally.ts` and
 * `scripts/py-codegraph-jedi-oracle.ts` — kept hand-copied duplicates of it.
 * When `importedName` landed at index 4, the tally was updated and the oracle
 * was not, so the oracle's own `chainDrift` guard fired (117 sites on flask,
 * 552 on ugnest) and every number it printed was void. A copy that must be
 * kept in sync by hand is a copy that will not be, so there is now exactly one
 * copy and the harnesses call it.
 *
 * Order IS precedence — see `python-resolver.ts` for what each pass claims and
 * why the terminal guards must precede `globalShortName`.
 *
 * `namingConvention` sits after `chainType` and before `importedName` (bd
 * tea-rags-mcp-0g8g5): it is the one GUESS in the chain, so every typed channel
 * answers first, and it must not preempt `importedName`, whose receiver is a
 * binding the walker actually recorded.
 *
 * The chain OPENS with the receiver-idiom block — `super`, `clsMember`,
 * `selfField`, `selfMember` — because each of those receivers names the
 * enclosing class and nothing else can, so no later pass has evidence to add
 * (bd tea-rags-mcp-w205u, E4.4a). What the block's position buys is precedence
 * over `namingConvention` and `globalShortName`, the two passes that would
 * otherwise GUESS at a `cls.` receiver; keeping the idioms contiguous is what
 * makes that argument readable in one place.
 */

import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { PythonAncestorLinearizerCache } from "./python-ancestor-policy.js";
import { PythonImportFileMapper } from "./python-import-file-mapper.js";
import {
  PythonChainTypeSymbolResolutionStrategy,
  PythonClsMemberSymbolResolutionStrategy,
  PythonGlobalShortNameSymbolResolutionStrategy,
  PythonImportedNameSymbolResolutionStrategy,
  PythonLocalBindingSymbolResolutionStrategy,
  PythonNamingConventionSymbolResolutionStrategy,
  PythonSelfFieldSymbolResolutionStrategy,
  PythonSelfMemberSymbolResolutionStrategy,
  PythonSuperSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

/**
 * The production chain, in production order.
 *
 * `mapper` is a parameter rather than a local because its memo is keyed by
 * symbol-table identity: `PythonCallResolver` owns ONE instance and hands it in
 * so every consumer it grows shares the resolved-root cache. A caller that has
 * no other consumer — either harness — omits it and gets a private one, which
 * is exactly the per-chain sharing the resolver has today.
 *
 * `linearizers` defaults the same way and for the same reason: an ancestor MRO
 * is memoized once per RUN (bd tea-rags-mcp-9fgdi, decision 7), so the cache
 * holding it belongs to whoever owns the resolver, and a caller with no second
 * consumer gets a private one rather than a per-call-site walk. It is a
 * PARAMETER and not a local because `PythonCallResolver` shares one instance
 * across everything it grows, exactly as it shares the mapper.
 *
 * Defaulted rather than optional-and-absent because the real pre-seam fallback
 * is a property of the CONTEXT, not of the caller: the cache answers
 * `undefined` for a run whose index carries no `classAncestors` (walker v2),
 * and each strategy keeps its old behaviour there. A harness that threads the
 * channel gets the seam without having to know the seam exists.
 */
export function createPythonSymbolResolutionChain(
  cfg: ResolverConfig,
  mapper: PythonImportFileMapper = new PythonImportFileMapper(),
  linearizers: PythonAncestorLinearizerCache = new PythonAncestorLinearizerCache(mapper, cfg.mode),
): SymbolResolutionStrategy[] {
  return [
    new PythonSuperSymbolResolutionStrategy(cfg, linearizers),
    new PythonClsMemberSymbolResolutionStrategy(cfg, linearizers),
    new PythonSelfFieldSymbolResolutionStrategy(cfg, mapper, linearizers),
    new PythonSelfMemberSymbolResolutionStrategy(cfg, linearizers),
    new PythonLocalBindingSymbolResolutionStrategy(cfg, mapper, linearizers),
    new PythonChainTypeSymbolResolutionStrategy(cfg, mapper, linearizers),
    new PythonNamingConventionSymbolResolutionStrategy(cfg, mapper, linearizers),
    new PythonImportedNameSymbolResolutionStrategy(cfg, mapper, linearizers),
    new PythonGlobalShortNameSymbolResolutionStrategy(cfg),
  ];
}
