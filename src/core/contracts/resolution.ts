/**
 * Runtime constructors for `SymbolResolutionOutcome` (the three-state result of
 * a single resolution pass — see `contracts/types/language.ts`). Kept out of
 * the type-only `types/language.ts` so that file stays runtime-free.
 *
 * Strategy bodies read better with these than with inline object literals:
 *
 *   if (!call.receiver) return CONTINUE;
 *   const hit = lookup(...);
 *   return hit ? resolved(hit) : CONTINUE;
 */

import type { SymbolResolutionOutcome } from "./types/language.js";
import type { SymbolResolutionTarget } from "./types/codegraph.js";

/** Pass owns the call and produced a target — the edge to emit. */
export function resolved(target: SymbolResolutionTarget): SymbolResolutionOutcome {
  return { kind: "resolved", target };
}

/** Pass owns the call but emits NO edge; STOP the chain (guard drop). */
export const DROP: SymbolResolutionOutcome = { kind: "drop" };

/** Not this pass's case; try the next pass. */
export const CONTINUE: SymbolResolutionOutcome = { kind: "continue" };
