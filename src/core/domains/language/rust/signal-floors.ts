import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Rust publishes no module-level limit either — clippy `too_many_lines` 100
 * bounds functions. Same reasoning as Go: a file carrying a type plus its
 * `impl` blocks is idiomatic, so the budget sits between TypeScript and Java.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 500, "god-module": 1000 },
  memberCount: { large: 15, "god-module": 30 },
  fileMethodCount: { busy: 15, "god-module": 30 },
};
