/**
 * Worker-side transport adapter. Symmetric counterpart of WorkerTransport —
 * lets a single worker entry run under either node:worker_threads (init via
 * workerData, messaging via parentPort) or child_process.fork (init via the
 * first {__init} IPC message, messaging via process.send).
 *
 * The entry point picks the correct implementation with createWorkerRuntime():
 *   - isMainThread === true  → forked process  → ProcessWorkerRuntime
 *   - isMainThread === false → Worker thread   → ThreadWorkerRuntime
 */

import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { SHUTDOWN_MESSAGE } from "./worker-transport.js";

/** Key under which ProcessTransport delivers the init payload as the first IPC message. */
export const INIT_KEY = "__init";

/**
 * Worker-side counterpart of WorkerTransport. Lets one worker entry run under
 * either node:worker_threads (init via workerData, messaging via parentPort) or
 * child_process.fork (init via the first {__init} IPC message, messaging via
 * process.send). The entry picks the impl with createWorkerRuntime().
 */
export interface WorkerRuntime<TInit, Req> {
  /** Resolve the init payload (workerData | first {__init} message). */
  init: () => Promise<TInit>;
  /** Register the request handler (shutdown + init envelopes are filtered out). */
  onRequest: (cb: (request: Req) => void) => void;
  /** Send one response to the parent. */
  respond: (response: unknown) => void;
  /** Register the graceful-shutdown handler. */
  onShutdown: (cb: () => void) => void;
}

function isShutdown(m: unknown): boolean {
  return typeof m === "object" && m !== null && (m as { type?: string }).type === SHUTDOWN_MESSAGE.type;
}

function isInit(m: unknown): boolean {
  return typeof m === "object" && m !== null && INIT_KEY in (m as Record<string, unknown>);
}

class ThreadWorkerRuntime<TInit, Req> implements WorkerRuntime<TInit, Req> {
  async init(): Promise<TInit> {
    return workerData as TInit;
  }
  onRequest(cb: (request: Req) => void): void {
    parentPort?.on("message", (m) => {
      if (isShutdown(m)) return;
      cb(m as Req);
    });
  }
  respond(response: unknown): void {
    parentPort?.postMessage(response);
  }
  onShutdown(cb: () => void): void {
    parentPort?.on("message", (m) => {
      if (isShutdown(m)) {
        parentPort?.close();
        cb();
      }
    });
  }
}

/**
 * Error codes `process.send` reports when the parent's end of the IPC channel is
 * gone: the pipe broke under a pending write (EPIPE / ECONNRESET), or the
 * channel was already marked disconnected (ERR_IPC_CHANNEL_CLOSED).
 */
const PARENT_CHANNEL_GONE_CODES: ReadonlySet<string> = new Set(["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED"]);

function isParentChannelGone(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && PARENT_CHANNEL_GONE_CODES.has(code);
}

/**
 * Forked-process runtime. A process worker has exactly one parent channel, and
 * the parent can vanish mid-request (SIGINT to a stdio server while a read is
 * chunking through the pool). `process.send` without a callback reports a
 * closed/broken channel as an `'error'` event on `process`, which — unhandled —
 * crashes the worker with a stack trace after the parent is already gone. So
 * `init()` takes ownership of the channel's lifetime: the IPC `'disconnect'`
 * and a channel-gone `'error'` both mean "nobody left to answer" and leave via
 * `onParentGone` (exit 0) at once, abandoning in-flight work; any other
 * `'error'` is rethrown, keeping its default crash semantics.
 */
export class ProcessWorkerRuntime<TInit, Req> implements WorkerRuntime<TInit, Req> {
  private parentGone = false;

  constructor(private readonly onParentGone: () => void = () => process.exit(0)) {}

  async init(): Promise<TInit> {
    this.watchParentChannel();
    return new Promise<TInit>((resolve) => {
      const onInit = (m: unknown): void => {
        if (isInit(m)) {
          process.off("message", onInit);
          resolve((m as Record<string, TInit>)[INIT_KEY]);
        }
      };
      process.on("message", onInit);
    });
  }
  onRequest(cb: (request: Req) => void): void {
    process.on("message", (m) => {
      if (isShutdown(m) || isInit(m)) return;
      cb(m as Req);
    });
  }
  respond(response: unknown): void {
    if (this.parentGone) return;
    process.send?.(response);
  }
  onShutdown(cb: () => void): void {
    process.on("message", (m) => {
      if (isShutdown(m)) cb();
    });
  }

  private watchParentChannel(): void {
    process.once("disconnect", () => {
      this.leave();
    });
    process.on("error", (error) => {
      if (!isParentChannelGone(error)) throw error;
      this.leave();
    });
  }

  private leave(): void {
    if (this.parentGone) return;
    this.parentGone = true;
    this.onParentGone();
  }
}

/** Pick the runtime: a forked process is the main thread; a Worker is not. */
export function createWorkerRuntime<TInit, Req>(): WorkerRuntime<TInit, Req> {
  return isMainThread ? new ProcessWorkerRuntime<TInit, Req>() : new ThreadWorkerRuntime<TInit, Req>();
}
