/**
 * Trajectory domain barrel — re-exports public API.
 */

export { TrajectoryRegistry } from "./registry.js";
export {
  TrajectoryError,
  TrajectoryGitError,
  TrajectoryStaticError,
  TrajectoryCodegraphError,
  GitBlameFailedError,
  GitLogTimeoutError,
  GitNotAvailableError,
  StaticParseFailedError,
  CodegraphSpillIoError,
  CodegraphResolveError,
  CodegraphCheckpointError,
  CodegraphMetricsError,
} from "./errors.js";
export type { TrajectoryErrorCode } from "./errors.js";
