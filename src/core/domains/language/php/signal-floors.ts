import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * PHPMD `ExcessiveClassLength` (1000 lines) and `TooManyMethods` (25). The
 * large step is the published threshold; the god step is twice the class
 * length and the same method count, so a file that is only long is not yet a
 * god module.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 1000, "god-module": 2000 },
  memberCount: { large: 15, "god-module": 25 },
  moduleMethodCount: { busy: 15, "god-module": 25 },
};
