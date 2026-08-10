/**
 * Runtime constructors for `SymbolResolutionOutcome` (the four-state result of
 * a single resolution pass — see `contracts/types/language.ts`). Kept out of
 * the type-only `types/language.ts` so that file stays runtime-free.
 *
 * Strategy bodies read better with these than with inline object literals:
 *
 *   if (!call.receiver) return CONTINUE;
 *   const hit = lookup(...);
 *   return hit ? resolved(hit) : CONTINUE;
 */

import type { SymbolResolutionTarget } from "./types/codegraph.js";
import type { SymbolResolutionOutcome } from "./types/language.js";

/** Pass owns the call and produced a target — the edge to emit. */
export function resolved(target: SymbolResolutionTarget): SymbolResolutionOutcome {
  return { kind: "resolved", target };
}

/**
 * Pass has a WEAK target and OFFERS it instead of committing: the chain keeps
 * running, and this target is emitted only if no later pass produces a stronger
 * one. The last-resort form of `resolved` — use it wherever a pass located the
 * target FILE but could not pin the member inside it (bd tea-rags-mcp-5onmn).
 */
export function deferred(target: SymbolResolutionTarget): SymbolResolutionOutcome {
  return { kind: "deferred", target };
}

/**
 * Pass owns the call but emits NO edge; STOP the chain (guard drop). Bars every
 * LATER pass from answering — it does NOT veto a proposal an EARLIER pass
 * already deferred, which the chain still emits (see `resolveViaChain`).
 */
export const DROP: SymbolResolutionOutcome = { kind: "drop" };

/** Not this pass's case; try the next pass. */
export const CONTINUE: SymbolResolutionOutcome = { kind: "continue" };
