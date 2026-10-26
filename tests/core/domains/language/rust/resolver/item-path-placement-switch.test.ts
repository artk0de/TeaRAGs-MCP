import { describe, expect, it } from "vitest";

import { CONTINUE, DROP, resolved } from "../../../../../../src/core/contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import type {
  SymbolResolutionOutcome,
  SymbolResolutionStrategy,
} from "../../../../../../src/core/contracts/types/language.js";
import {
  rustItemPathPlacementEnabled,
  rustItemPathPlacements,
  rustNoteItemPathPlacement,
  rustPlacementAdditiveStrategy,
  rustWithoutItemPathPlacement,
} from "../../../../../../src/core/domains/language/rust/resolver/item-path-placement-switch.js";

const PLACED = resolved({ targetRelPath: "src/placed.rs", targetSymbolId: "Placed.new" });
const UNPLACED = resolved({ targetRelPath: "src/old.rs", targetSymbolId: "Old.new" });
const CALL = { callText: "T::new()", member: "new", receiver: "T" } as unknown as CallRef;
const CTX = {} as CallContext;

/** A pass that answers `withPlacement` when placement is on (counting it), `without` when it is off. */
function pass(withPlacement: SymbolResolutionOutcome, without: SymbolResolutionOutcome): SymbolResolutionStrategy {
  return {
    name: "probe",
    attempt: () => {
      if (!rustItemPathPlacementEnabled()) return without;
      rustNoteItemPathPlacement();
      return withPlacement;
    },
  };
}

describe("rustPlacementAdditiveStrategy", () => {
  it("passes the verdict through untouched when no placement answered", () => {
    const silent: SymbolResolutionStrategy = { name: "silent", attempt: () => DROP };
    const before = rustItemPathPlacements();
    expect(rustPlacementAdditiveStrategy(silent, { placesTarget: false }).attempt(CALL, CTX)).toBe(DROP);
    expect(rustItemPathPlacements()).toBe(before);
  });

  it("answers with the placement only where the pre-placement read is silent", () => {
    const strategy = rustPlacementAdditiveStrategy(pass(PLACED, CONTINUE), { placesTarget: false });
    expect(strategy.attempt(CALL, CTX)).toEqual(PLACED);
  });

  it("keeps the pre-placement resolution over a placed one", () => {
    const strategy = rustPlacementAdditiveStrategy(pass(PLACED, UNPLACED), { placesTarget: true });
    expect(strategy.attempt(CALL, CTX)).toEqual(UNPLACED);
  });

  it("keeps a name-only pass's pre-placement drop over a placed resolution", () => {
    const strategy = rustPlacementAdditiveStrategy(pass(PLACED, DROP), { placesTarget: false });
    expect(strategy.attempt(CALL, CTX)).toBe(DROP);
  });

  it("lets a pass that resolves on the placed definition answer over its pre-placement drop", () => {
    const strategy = rustPlacementAdditiveStrategy(pass(PLACED, DROP), { placesTarget: true });
    expect(strategy.attempt(CALL, CTX)).toEqual(PLACED);
  });

  it("keeps the pre-placement verdict when the placed read does not resolve", () => {
    expect(rustPlacementAdditiveStrategy(pass(CONTINUE, DROP), { placesTarget: true }).attempt(CALL, CTX)).toBe(DROP);
    expect(rustPlacementAdditiveStrategy(pass(DROP, CONTINUE), { placesTarget: true }).attempt(CALL, CTX)).toBe(
      CONTINUE,
    );
  });

  it("turns placement off only for the read it wraps", () => {
    expect(rustWithoutItemPathPlacement(() => rustItemPathPlacementEnabled())).toBe(false);
    expect(rustItemPathPlacementEnabled()).toBe(true);
  });
});
