import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Anchors: pylint `max-module-lines` 1000 and `too-many-public-methods` 20.
 * Python's published module budget is the roomiest of the scripting languages.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 500, "god-module": 1000 },
  memberCount: { large: 20, "god-module": 30 },
  moduleMethodCount: { busy: 20, "god-module": 35 },
};
