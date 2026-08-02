import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Anchors: Sonar `java:S104` 750 lines per file and `java:S1448` 35 methods per
 * class. Checkstyle's `FileLength` 2000 is the looser historical default and is
 * deliberately not used — it predates the Sonar guidance and flags almost
 * nothing.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 750, "god-module": 1500 },
  memberCount: { large: 20, "god-module": 35 },
  fileMethodCount: { busy: 20, "god-module": 35 },
};
