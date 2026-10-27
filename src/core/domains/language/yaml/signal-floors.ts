import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Doc-only language: its chunks carry `doc:` symbolIds and the symbol-mass pass
 * skips them, so no mass signal reaches a YAML payload. Empty rather than
 * absent — the contract requires every language to answer.
 */
export const signalFloors: SignalFloors = {};
