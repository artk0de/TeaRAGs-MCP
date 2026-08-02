import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Go publishes no module-level limit — `golangci-lint funlen` bounds functions
 * at 60 lines and nothing bounds the file. These sit between the TypeScript and
 * Java anchors, matching a language whose files routinely carry a type plus its
 * whole method set.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 500, "god-module": 1000 },
  memberCount: { large: 15, "god-module": 30 },
  moduleMethodCount: { busy: 15, "god-module": 30 },
};
