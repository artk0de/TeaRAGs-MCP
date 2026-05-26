/**
 * Codegraph daemon module — public surface barrel.
 *
 * Per `.claude/rules/barrel-files.md`: cross-boundary imports go through this
 * barrel. The bootstrap factory imports lifecycle helpers + the entry path
 * resolution from here; tests and the pool import the protocol codec + client.
 */

export {
  decodeFrames,
  encodeFrame,
  type DaemonOp,
  type DaemonRequest,
  type DaemonResponse,
} from "./protocol.js";
export { DaemonGraphDbClient, UnsupportedDaemonReadError } from "./client.js";
export { CodegraphDaemonServer, computeAndPersistCyclesAndSignals } from "./server.js";
export {
  type CodegraphDaemonPaths,
  IDLE_SHUTDOWN_MS,
  decrementRefs,
  getDaemonPaths,
  getStorageDir,
  incrementRefs,
  readRefs,
  scheduleIdleWatcher,
} from "./lifecycle.js";
export {
  createConnectionHandler,
  runDaemon,
  type DaemonRuntimeOptions,
} from "./entry.js";
