/**
 * Codegraph L1 family factory.
 *
 * The shared `Trajectory` contract is unchanged. `TrajectoryRegistry`
 * sees only L2 trajectories (slice 1: SymbolsTrajectory; slice 5+:
 * TemporalTrajectory etc.). The factory exists so a single config flag
 * (`CODEGRAPH_DISABLED`) toggles the whole family on or off without
 * leaking a `family` marker into the shared contract.
 */

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { CallResolver } from "../../../contracts/types/codegraph.js";
import type { SymbolIdComposer } from "../../../contracts/types/language.js";
import type { Trajectory } from "../../../contracts/types/trajectory.js";
import type { CodegraphExclusionOptions } from "./exclusion.js";
import { createSymbolsTrajectory } from "./symbols/index.js";

/**
 * Codegraph wiring deps — the trajectory family relies on a
 * **per-collection** pool of DuckDB clients rather than a single shared
 * graph DB. The pool lazily opens / migrates / hydrates
 * `<dataDir>/codegraph/<collectionName>.duckdb` on first use for each
 * indexed project, eliminating PK collisions between projects and
 * localising DuckDB's single-writer file lock to within one project's
 * scope.
 *
 * Resolvers (TS, Python, Go, …) are process-scoped — they hold language
 * parsers and tsconfig state, neither of which depends on the indexed
 * collection.
 */
export interface CodegraphDeps {
  pool: GraphDbClientPool;
  resolvers: Map<string, CallResolver>;
  /**
   * Cross-language symbolId mapper injected into the provider's `joinSymbol`
   * (replacing the local `#`/`.`/scopeSeparator convention logic). Typed as
   * the contracts `SymbolIdComposer` interface — the concrete is wired by
   * `bootstrap/factory.ts`, never imported here (leaf-domain guard).
   */
  composer: SymbolIdComposer;
  /**
   * Codegraph-layer exclusion config — applied AFTER FileScanner's
   * ignoreFilter inside `discoverSupportedFiles`. Wired from
   * `codegraphSchema.excludeTests` + `codegraphSchema.customExcludePatterns`
   * by the bootstrap factory. Default (production wiring) is
   * `{ excludeTests: true, customPatterns: [] }` — tests are kept out of
   * the dependency graph but main Qdrant ingest still indexes them.
   */
  exclusion: CodegraphExclusionOptions;
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
export { buildCodegraphExclusionFilter, CODEGRAPH_TEST_PATTERNS } from "./exclusion.js";
export type { CodegraphExclusionOptions } from "./exclusion.js";
