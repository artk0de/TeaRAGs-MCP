/**
 * Codegraph L1 family factory.
 *
 * The shared `Trajectory` contract is unchanged. `TrajectoryRegistry`
 * sees only L2 trajectories (slice 1: SymbolsTrajectory; slice 5+:
 * TemporalTrajectory etc.). The factory exists so a single config flag
 * (`CODEGRAPH_DISABLED`) toggles the whole family on or off without
 * leaking a `family` marker into the shared contract.
 */

import type { CallResolver, GlobalSymbolTable, GraphDbClient } from "../../../contracts/types/codegraph.js";
import type { Trajectory } from "../../../contracts/types/trajectory.js";
import { createSymbolsTrajectory } from "./symbols/index.js";

export interface CodegraphDeps {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
  resolvers: Map<string, CallResolver>;
}

/**
 * Returns the array of L2 trajectories that belong to the codegraph
 * family. Slice 1: SymbolsTrajectory only. Slice 5+ appends Temporal,
 * etc.
 */
export function createCodegraphTrajectories(deps: CodegraphDeps): Trajectory[] {
  return [createSymbolsTrajectory(deps)];
}

export { createSymbolsTrajectory } from "./symbols/index.js";
