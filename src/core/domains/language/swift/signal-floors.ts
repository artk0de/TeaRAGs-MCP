import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Anchors: SwiftLint `file_length` warning 400 / error 1000 for the module
 * axes. Swift's idiomatic file carries one type plus its extension methods, so
 * the member budgets sit at the Go/Rust level rather than Java's — SwiftLint
 * has no member-count rule of its own to anchor on.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 400, "god-module": 1000 },
  memberCount: { large: 15, "god-module": 30 },
  moduleMethodCount: { busy: 15, "god-module": 30 },
};
