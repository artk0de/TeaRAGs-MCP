import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Doc-only language: its chunks carry `doc:` symbolIds and the symbol-mass pass
 * skips them entirely, so no mass signal ever reaches a markdown payload. Empty
 * rather than absent — the contract requires every language to answer, and this
 * is the answer.
 */
export const signalFloors: SignalFloors = {};
