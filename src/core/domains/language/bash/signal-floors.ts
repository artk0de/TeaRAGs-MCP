import type { SignalFloors } from "../../../contracts/types/trajectory.js";

/**
 * Bash has no class construct, so `memberCount` never reaches a payload here —
 * the key is declared empty rather than omitted, stating that as a decision
 * rather than an oversight. Line and function budgets follow the TypeScript
 * anchors; shellcheck bounds neither.
 */
export const signalFloors: SignalFloors = {
  moduleLines: { large: 300, "god-module": 600 },
  memberCount: {},
  moduleMethodCount: { busy: 15, "god-module": 30 },
};
