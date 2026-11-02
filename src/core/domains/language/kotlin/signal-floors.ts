import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Anchors: detekt `LargeClass` threshold 600 and `TooManyFunctions` threshold
 * 11. The god-module axes are twice those warnings.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 600, "god-module": 1200 },
  memberCount: { large: 11, "god-module": 22 },
  moduleMethodCount: { busy: 11, "god-module": 22 },
};
