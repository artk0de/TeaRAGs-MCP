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

class ProcessWorkerRuntime<TInit, Req> implements WorkerRuntime<TInit, Req> {
  async init(): Promise<TInit> {
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
    process.send?.(response);
  }
  onShutdown(cb: () => void): void {
    process.on("message", (m) => {
      if (isShutdown(m)) cb();
    });
  }
}

/** Pick the runtime: a forked process is the main thread; a Worker is not. */
export function createWorkerRuntime<TInit, Req>(): WorkerRuntime<TInit, Req> {
  return isMainThread ? new ProcessWorkerRuntime<TInit, Req>() : new ThreadWorkerRuntime<TInit, Req>();
}
