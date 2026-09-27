/**
 * A BARE call binds its callee by LEXICAL scope, and this pass asks the checker
 * which declaration that is before any short-name pass guesses
 * (bd tea-rags-mcp-bv0tq).
 *
 * `sameFile` matches a bare callee against every short name the caller's FILE
 * declares, and `globalShortName` against the whole project. Neither knows about
 * scopes, so both went wrong in opposite directions on the same shape:
 *
 *   - a PARAMETER named like a function another function in the file declares —
 *     live on tea-rags, `runIndexWorker(…, send)` calling `send(...)` seven
 *     times landed on `main.send`, the function-scoped arrow `main` passes in.
 *     The local-callee guard (bd tea-rags-mcp-5tatv) sat only in
 *     `globalShortName`, one pass after `sameFile` had already committed;
 *   - a function's OWN nested helper — `function close() {}` inside
 *     `parseSnapshot` — went unresolved the moment a namesake existed elsewhere
 *     in the file, because both passes read the collision as ambiguity.
 *
 * The checker's `getSymbolAtLocation` names the declaration outright, so:
 *
 *   - `parameter` → DROP. The value is whatever the caller passes; no
 *     declaration in the project is evidence about it, and a short-name match is
 *     a fabrication by construction;
 *   - `localFunction` → the symbol the walker recorded for that declaration,
 *     picked among the caller file's short-name matches by SCOPE. A declaration
 *     the scope mirror cannot place returns CONTINUE — exactly the pre-fix
 *     behaviour, never a guess;
 *   - `localValue` → only the checker tier may answer (a call-result binding is
 *     `callResultCallee`'s, an alias of a project function is
 *     `typeCheckerFallback`'s), so it runs that tier and DROPs on no answer. The
 *     short-name passes between here and there are exactly what this skips.
 *
 * Chain position: immediately ahead of `sameFile`. Every earlier pass is
 * receiver-gated or answers a bare call from exact import evidence, and the cost
 * gate is the one `calleeIsLocalValueBinding` uses — no project symbol of that
 * name means no short-name pass could fabricate anything, so the checker is not
 * asked.
 */

import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { resolveViaChain } from "../../../resolver-chain.js";
import { lookupEcmascriptSymbolsByShortName } from "../../../shared/ecmascript-symbol-lookup.js";
import { classifyLexicalCallee } from "../ts-local-callee.js";
import type { TSProgramCache } from "../ts-program-cache.js";
import { sameWalkerScope } from "../ts-walker-scope.js";

export class TSLexicalCalleeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "lexicalCallee";

  /**
   * @param checkerTier the passes that read what a local binding HOLDS through
   *   the compiler — the same instances the chain runs at its tail, so a
   *   local-value callee is answered exactly as it would have been had the
   *   short-name passes declined it.
   */
  constructor(
    private readonly programCache: TSProgramCache,
    private readonly checkerTier: readonly SymbolResolutionStrategy[],
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null) return CONTINUE;
    const namesakes = lookupEcmascriptSymbolsByShortName(ctx, call.member, { role: "callee" });
    if (namesakes.length === 0) return CONTINUE;

    const binding = classifyLexicalCallee(call, ctx, this.programCache);
    switch (binding.kind) {
      case "none":
        return CONTINUE;
      case "parameter":
        return DROP;
      case "localValue": {
        const target = resolveViaChain(this.checkerTier, call, ctx);
        return target === null ? DROP : resolved(target);
      }
      case "localFunction": {
        const { scope } = binding;
        if (scope === null) return CONTINUE;
        const own = namesakes.filter((def) => def.relPath === ctx.callerFile && sameWalkerScope(def.scope, scope));
        return own.length === 1
          ? resolved({ targetRelPath: own[0].relPath, targetSymbolId: own[0].symbolId })
          : CONTINUE;
      }
    }
  }
}
