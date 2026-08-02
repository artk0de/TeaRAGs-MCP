import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Anchors: ESLint `max-lines` 300 (physical lines, the unit `moduleLines`
 * measures) and PMD `TooManyMethods` 10. `moduleMethodCount` has no per-FILE
 * published limit anywhere in the industry — every rule counts methods per
 * class — so its numbers take the class limit with headroom for a file holding
 * a few classes. Calibration, not citation.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 300, "god-module": 600 },
  memberCount: { large: 10, "god-module": 20 },
  moduleMethodCount: { busy: 15, "god-module": 30 },
};
