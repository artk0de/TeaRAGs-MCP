/**
 * Factory for the TypeScript `SymbolResolutionStrategy` chain consumed by
 * `TSCallResolver#resolve` through the shared `resolveViaChain` engine.
 *
 * Owns the construction and the ORDER of the chain (precedence = array order;
 * the per-pass rationale lives beside each entry). The pass-by-pass table is
 * documented in `ts-resolver.ts`. Passes 12-16 (the checker tier) exist only
 * when a `TSProgramCache` is supplied — `CODEGRAPH_TS_TYPECHECKER=0` hands in
 * `null` and the chain is built without them (bd tea-rags-mcp-uclbn).
 */

import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import type { TSProgramCache } from "./program/index.js";
import {
  TSCallResultCalleeSymbolResolutionStrategy,
  TSFieldTypeSymbolResolutionStrategy,
  TSGlobalShortNameSymbolResolutionStrategy,
  TSImportBasenameSymbolResolutionStrategy,
  TSImportedCalleeSymbolResolutionStrategy,
  TSImportNarrowedFallbackSymbolResolutionStrategy,
  TSLexicalCalleeSymbolResolutionStrategy,
  TSLocalBindingSymbolResolutionStrategy,
  TSNamedImportSymbolResolutionStrategy,
  TSReceiverSymbolSymbolResolutionStrategy,
  TSSameFileSymbolResolutionStrategy,
  TSStructuralTypingSymbolResolutionStrategy,
  TSSuperSymbolResolutionStrategy,
  TSThisMemberSymbolResolutionStrategy,
  TSTypeCheckerFallbackSymbolResolutionStrategy,
  TSTypeCheckerJsxComponentSymbolResolutionStrategy,
  TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy,
  type ResolverConfig,
} from "./strategies/index.js";

/** The built chain plus the declared-type subset the `.call` / `.apply` / `.bind` pre-step reuses. */
export interface TSSymbolResolutionChain {
  /** The main ordered chain; array order encodes precedence. */
  strategies: SymbolResolutionStrategy[];
  /**
   * The declared-type passes that decide whether an unwrapped `.call` /
   * `.apply` / `.bind` site is really a member call (bd tea-rags-mcp-g7h1y).
   * The same instances the main chain runs.
   */
  functionInvokerSiteStrategies: readonly SymbolResolutionStrategy[];
}

/**
 * Build the TypeScript symbol-resolution chain.
 *
 * @param cfg Resolver configuration shared by every pass.
 * @param programCache Shared `ts.Program` cache backing the checker tier, or
 *   `null` when the type checker is disabled (the checker passes are then
 *   omitted from the chain entirely).
 */
export function createTSSymbolResolutionChain(
  cfg: ResolverConfig,
  programCache: TSProgramCache | null,
): TSSymbolResolutionChain {
  const fieldType = new TSFieldTypeSymbolResolutionStrategy(cfg);
  const localBinding = new TSLocalBindingSymbolResolutionStrategy(cfg);
  const functionInvokerSiteStrategies = [fieldType, localBinding];
  const checkerTier: SymbolResolutionStrategy[] = programCache
    ? [
        // Head of the checker tier bar the JSX pass, and the index is a
        // correctness argument in one direction only (bd tea-rags-mcp-kf42k).
        // Everything ahead of it either answers a receiver or answers a bare
        // call from exact evidence — an import binding, the caller's own file —
        // and this pass would have nothing to add there. Against
        // `typeCheckerFallback` it decides the family: both reach the same
        // declaration through `getResolvedSignature`, but the fallback degrades
        // to a file-only edge where the symbol table cannot confirm the member,
        // and the MEMBER is the whole answer here. Behind the JSX pass because a
        // React component is routinely `const Page = lazy(() => …)` — a
        // call-result binding by shape — and its tag is that pass's case.
        new TSCallResultCalleeSymbolResolutionStrategy(cfg, programCache),
        new TSTypeCheckerReturnTypeInferenceSymbolResolutionStrategy(cfg, programCache),
        new TSTypeCheckerFallbackSymbolResolutionStrategy(cfg, programCache),
        new TSStructuralTypingSymbolResolutionStrategy(cfg, programCache),
      ]
    : [];
  const strategies: SymbolResolutionStrategy[] = [
    new TSSuperSymbolResolutionStrategy(cfg),
    new TSThisMemberSymbolResolutionStrategy(cfg),
    fieldType,
    localBinding,
    new TSNamedImportSymbolResolutionStrategy(cfg, programCache),
    // 6 answers only JSX TAGS, and its index is the whole fix for bd
    // tea-rags-mcp-33lqo: on taxdome, jsx carried 1,279 of the 1,479
    // `wrongFile` defects (86%), and the checker had the right answer for
    // every one of them — it just never got a turn from the tail.
    //
    // The cause is a React idiom the walker cannot name.
    // `export { refForwarded as Card }` over a `forwardRef` / `memo` wrapper
    // leaves NO `Card` symbol in the file the caller imports it from, so
    // `importedCallee` maps the import to the right file, finds nothing there,
    // reads that as "must be a barrel" and hops to the one `Card` the project
    // does declare — an unrelated component. 942 rows arrived that way; a
    // further 293 arrived through `globalShortName` on the same missing
    // symbol. Declining those passes fixes nothing on its own: measured over
    // the same corpus, 931 of the 942 are then answered IDENTICALLY WRONG by
    // the next short-name pass down.
    //
    // Ordering fixes it because the checker resolves the tag's own symbol
    // through the alias, whatever the walker managed to record. Measured over
    // all 50,023 taxdome jsx sites: 1,287 move to the file the checker names
    // (every one a known `wrongFile` row), 47,409 keep the answer the cheap
    // passes already gave, and 2 lose an edge.
    //
    // It cannot disturb a non-JSX call: the pass returns CONTINUE unless
    // `call.jsx === true`. It cannot cost recall when the checker is absent
    // either — `CODEGRAPH_TS_TYPECHECKER=0` removes the cache and with it this
    // entry, and a warmed-up-but-unavailable Program makes `acquire` return
    // null, so the tree-sitter passes below answer exactly as they do today.
    ...(programCache ? [new TSTypeCheckerJsxComponentSymbolResolutionStrategy(cfg, programCache)] : []),
    // 7 answers only BARE calls, so every receiver-gated pass reaches it as
    // CONTINUE and its index against 1-5, 7 and 8 decides nothing. Against 9
    // it decides a lot, and the direction was MEASURED (bd tea-rags-mcp-w65s7):
    // `sameFile` matches a bare callee against every short name the caller's
    // file declares, INCLUDING its own methods, so `GitCliAdapter#getHead`
    // swallowed the imported free function `getHead` it delegates to. Running
    // ahead of it turned 18 of this repo's bareCall `wrongFile` rows into
    // matches and cost none — an imported binding called bare is never the
    // enclosing class's method. It must also stay above the short-name passes
    // at 10 and 11, whose guess must not beat exact import evidence. No
    // Program cache: pure symbol-table work, and acquiring a checker this
    // early would pay for calls the cheap passes were about to answer.
    new TSImportedCalleeSymbolResolutionStrategy(cfg),
    // 7 takes it for the guard on its PARK (bd tea-rags-mcp-83iz5): the
    // basename match fires on receiver TEXT, so a local `cache` collides with
    // the `cache.ts` its own file imports, and only the checker can see that
    // the receiver is a `Map`.
    new TSImportBasenameSymbolResolutionStrategy(cfg, programCache),
    new TSReceiverSymbolSymbolResolutionStrategy(cfg),
    // Ahead of `sameFile` because that pass matches a bare callee against
    // every short name the caller's file declares, blind to scope: a
    // PARAMETER `send` landed on the `main.send` another function declares,
    // and a function's own nested helper went unresolved beside a namesake
    // (bd tea-rags-mcp-bv0tq). This pass asks the checker which declaration
    // the identifier binds; local values it hands to the checker tier and
    // nothing else, so the two short-name passes below never see them.
    ...(programCache ? [new TSLexicalCalleeSymbolResolutionStrategy(programCache, checkerTier)] : []),
    new TSSameFileSymbolResolutionStrategy(cfg),
    // 10 and 11 take the Program cache for their three GUARDS, not to resolve
    // with: `targetsExternalImport` for receivers only the checker can type
    // (bd tea-rags-mcp-335eu), `calleeIsLocalValueBinding` for a bare call
    // whose callee is a local binding (bd tea-rags-mcp-5tatv), and
    // `receiverIsUnpinnableLocalValueBinding` for the dispatching twin —
    // a receiver that is itself a local binding the checker can name no
    // in-project type for (bd tea-rags-mcp-z0zqd).
    new TSGlobalShortNameSymbolResolutionStrategy(cfg, programCache),
    new TSImportNarrowedFallbackSymbolResolutionStrategy(cfg, programCache),
    ...checkerTier,
  ];
  return { strategies, functionInvokerSiteStrategies };
}
