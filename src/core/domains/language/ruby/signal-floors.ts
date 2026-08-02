import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * The tightest budget of any language here: RuboCop ships
 * `Metrics/ClassLength` and `Metrics/ModuleLength` at 100 lines, which is
 * roughly a third of the ESLint allowance, and Ruby style genuinely runs to
 * smaller files.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 100, "god-module": 250 },
  memberCount: { large: 10, "god-module": 20 },
  moduleMethodCount: { busy: 12, "god-module": 25 },
};
