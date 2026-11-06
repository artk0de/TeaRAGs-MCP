import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Objective-C has no file-length lint in the default clang set. The budgets
 * match SwiftLint `file_length` (warning 400 / error 1000): `.m` files sit
 * next to Swift in the same Apple codebases, and SwiftLint is the published
 * rule those trees already live under.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 400, "god-module": 1000 },
  memberCount: { large: 15, "god-module": 30 },
  moduleMethodCount: { busy: 15, "god-module": 30 },
};
