import type { CallContext, CallRef } from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../contracts/types/language.js";

/**
 * Item-path placement (`rustPlaceItemPath`) is ADDITIVE (the language
 * navigator's invariant): it answers where the read without it is silent, and
 * every other call reads exactly as before. This switch is how the resolver
 * gets that read back: placement can be turned off for one synchronous read,
 * and every placement that answered is counted, so a read that placed nothing
 * is never repeated.
 */
let placementOff = false;
let placements = 0;

/** Whether item-path placement may answer in the current read. */
export function rustItemPathPlacementEnabled(): boolean {
  return !placementOff;
}

/** Record that a placement answered — the read it served may differ from the pre-placement one. */
export function rustNoteItemPathPlacement(): void {
  placements++;
}

/** The running count of placements that answered; compare two reads of it to see whether any did. */
export function rustItemPathPlacements(): number {
  return placements;
}

/** `read` with item-path placement off: the resolver's read as it was before placement existed. */
export function rustWithoutItemPathPlacement<T>(read: () => T): T {
  const previous = placementOff;
  placementOff = true;
  try {
    return read();
  } finally {
    placementOff = previous;
  }
}

/**
 * `strategy` with placement made additive at its own verdict: where a
 * placement answered during the attempt, the pre-placement attempt is read
 * too. The placement's resolution answers where that read is SILENT
 * (`continue`) — and, for a strategy that resolves ON the placed definition
 * (`placesTarget`: a typed receiver's member, a module path's item), also
 * where that read DROPPED: its drop was a typed miss on a name it could not
 * place (tikv's two `RpcClient`s). Every other verdict of the pre-placement
 * read stands. So placement never turns a DROP into a CONTINUE that lets a
 * later name-only pass guess (servo's `key_path_string.split('.')` onto a
 * project `split`), a CONTINUE into a DROP that silences a later pass (tikv's
 * `WriteMsg::WriteTask(..)` variant), nor overrides a resolution.
 */
export function rustPlacementAdditiveStrategy(
  strategy: SymbolResolutionStrategy,
  { placesTarget }: { readonly placesTarget: boolean },
): SymbolResolutionStrategy {
  const overridable = (attempt: SymbolResolutionOutcome): boolean =>
    attempt.kind === "continue" || (placesTarget && attempt.kind === "drop");
  return {
    name: strategy.name,
    attempt: (call: CallRef, ctx: CallContext): SymbolResolutionOutcome => {
      const before = placements;
      const placed = strategy.attempt(call, ctx);
      if (placements === before) return placed;
      const unplaced = rustWithoutItemPathPlacement(() => strategy.attempt(call, ctx));
      return placed.kind === "resolved" && overridable(unplaced) ? placed : unplaced;
    },
  };
}
