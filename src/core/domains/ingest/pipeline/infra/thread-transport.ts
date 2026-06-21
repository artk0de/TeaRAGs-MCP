import { Worker } from "node:worker_threads";

import { SHUTDOWN_MESSAGE, type WorkerHandle, type WorkerTransport } from "./worker-transport.js";

/**
 * node:worker_threads transport — the pool's original spawn mechanics. `init`
 * is passed as `workerData`. Graceful shutdown posts SHUTDOWN_MESSAGE so the
 * worker can close its parentPort and let tree-sitter NAPI destructors run in
 * the correct thread (avoiding the libc++abi crash a bare terminate() causes).
 */
export class ThreadTransport<Req, Res> implements WorkerTransport<Req, Res> {
  constructor(private readonly workerPath: string) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const worker = new Worker(this.workerPath, { workerData: init });
    return {
      post: (request) => {
        worker.postMessage(request);
      },
      onMessage: (cb) => worker.on("message", cb),
      onError: (cb) => worker.on("error", cb),
      onExit: (cb) =>
        worker.once("exit", () => {
          cb();
        }),
      shutdown: () => {
        worker.unref();
        worker.postMessage(SHUTDOWN_MESSAGE);
      },
      terminate: async () => {
        await worker.terminate();
      },
    };
  }
}
