/**
 * Codegraph daemon module — public surface barrel.
 *
 * Per `.claude/rules/barrel-files.md`: cross-boundary imports go through this
 * barrel. The bootstrap factory imports lifecycle helpers + the entry path
 * resolution from here; tests and the pool import the protocol codec + client.
 */

export { decodeFrames, encodeFrame, type DaemonOp, type DaemonRequest, type DaemonResponse } from "./protocol.js";
export { DaemonGraphDbClient, UnsupportedDaemonReadError } from "./client.js";
export { computeAndPersistCyclesAndSignals } from "./graph-analysis.js";
export { DAEMON_OP_COMMANDS, type DaemonOpCommand, type DaemonOpContext } from "./op-commands.js";
export { CodegraphDaemonServer } from "./server.js";
export {
  type CodegraphDaemonPaths,
  DAEMON_LOG_MAX_BYTES,
  IDLE_SHUTDOWN_MS,
  decrementRefs,
  getDaemonLogPath,
  getDaemonPaths,
  getStorageDir,
  incrementRefs,
  openDaemonLogFd,
  readRefs,
  scheduleIdleWatcher,
} from "./lifecycle.js";
export { createConnectionHandler, createIdleShutdown, runDaemon, type DaemonRuntimeOptions } from "./entry.js";
export {
  DaemonMemoryGovernor,
  DEFAULT_MEMORY_LIMIT_BASE,
  DEFAULT_MEMORY_LIMIT_MAX,
  type DaemonMemoryGovernorOptions,
} from "./memory-governor.js";
