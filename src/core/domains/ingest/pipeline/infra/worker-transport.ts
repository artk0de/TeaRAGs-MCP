/**
 * Pluggable worker transport for WorkerDispatchPool. Abstracts the difference
 * between node:worker_threads and child_process.fork so the pool's distribution
 * mechanics stay transport-agnostic. tree-sitter's native parse is
 * process-globally thread-unsafe, so the chunker uses the process transport;
 * the enrichment executor keeps the thread transport.
 */

/** Graceful-shutdown control message posted to a worker before termination. */
export const SHUTDOWN_MESSAGE = { type: "shutdown" } as const;
export type ShutdownMessage = typeof SHUTDOWN_MESSAGE;

/** A live worker (thread or process) the pool dispatches to. */
export interface WorkerHandle<Req, Res> {
  /** Send one request to the worker. */
  post: (request: Req) => void;
  /** Register the single result/error-envelope listener. */
  onMessage: (cb: (message: Res | { error: string }) => void) => void;
  /** Register the transport-error listener. */
  onError: (cb: (error: Error) => void) => void;
  /** Register the exit listener (fires once the worker has terminated). */
  onExit: (cb: () => void) => void;
  /** Graceful shutdown: post SHUTDOWN_MESSAGE and unref so the worker can exit cleanly. */
  shutdown: () => void;
  /** Forceful termination, used as a timeout fallback after shutdown(). */
  terminate: () => Promise<void>;
}

/** Factory for worker handles. The pool owns poolSize/name; the transport owns the spawn mechanics. */
export interface WorkerTransport<Req, Res> {
  /** Spawn one worker, passing `init` as its serializable init payload (workerData | {__init} message). */
  spawn: (init: unknown) => WorkerHandle<Req, Res>;
}
