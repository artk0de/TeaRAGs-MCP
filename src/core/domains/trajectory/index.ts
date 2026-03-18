/**
 * Trajectory domain barrel — re-exports public API.
 */

export { TrajectoryRegistry } from "./registry.js";
export {
  TrajectoryError,
  TrajectoryGitError,
  TrajectoryStaticError,
  GitBlameFailedError,
  GitLogTimeoutError,
  GitNotAvailableError,
  StaticParseFailedError,
} from "./errors.js";
