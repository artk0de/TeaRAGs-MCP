import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/** Same toolchain as TypeScript — ESLint `max-lines` 300 governs both. */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 300, "god-module": 600 },
  memberCount: { large: 10, "god-module": 20 },
  fileMethodCount: { busy: 15, "god-module": 30 },
};
