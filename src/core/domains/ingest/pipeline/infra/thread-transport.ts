import { Worker, type WorkerOptions } from "node:worker_threads";

import { SHUTDOWN_MESSAGE, type WorkerHandle, type WorkerTransport } from "./worker-transport.js";

/**
 * node:worker_threads transport — the pool's original spawn mechanics. `init`
 * is passed as `workerData`. Graceful shutdown posts SHUTDOWN_MESSAGE so the
 * worker can close its parentPort and let tree-sitter NAPI destructors run in
 * the correct thread (avoiding the libc++abi crash a bare terminate() causes).
 */
export class ThreadTransport<Req, Res> implements WorkerTransport<Req, Res> {
  /**
   * @param workerPath Module the worker thread runs.
   * @param maxOldGenerationSizeMb Heap ceiling for each spawned thread, in MB.
   *   Omitted (or `0`) leaves the thread on the process-wide limit. When a
   *   thread breaches the ceiling V8 kills THAT THREAD and Node reports it as an
   *   `error` event carrying `ERR_WORKER_OUT_OF_MEMORY` — which the pool turns
   *   into a rejected dispatch plus a respawned slot, instead of the whole host
   *   swapping to a standstill (bd tea-rags-mcp-8qf86).
   */
  /**
   * @param workerPath Module the worker thread runs.
   * @param maxOldGenerationSizeMb Heap ceiling for each spawned thread, in MB.
   *   Omitted (or `0`) leaves the thread on the process-wide limit. When a
   *   thread breaches the ceiling V8 kills THAT THREAD and Node reports it as
   *   an `error` event carrying `ERR_WORKER_OUT_OF_MEMORY` — which the pool
   *   turns into a rejected dispatch plus a respawned slot, instead of the
   *   whole host swapping to a standstill (bd tea-rags-mcp-8qf86).
   * @param cpuProfileDir Diagnostic-only: when set, each spawned thread runs
   *   with `--cpu-prof`, writing a `.cpuprofile` to this directory on
   *   `worker.terminate()` / normal thread exit. Off by default — profiling
   *   has its own (small) overhead and no default run should pay it.
   */
  constructor(
    private readonly workerPath: string,
    private readonly maxOldGenerationSizeMb?: number,
    private readonly cpuProfileDir?: string,
  ) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const options: WorkerOptions = { workerData: init };
    // Set only when a real ceiling was asked for: passing `resourceLimits` with
    // a zero would cap the thread at nothing rather than leave it unbounded.
    if (this.maxOldGenerationSizeMb !== undefined && this.maxOldGenerationSizeMb > 0) {
      options.resourceLimits = { maxOldGenerationSizeMb: this.maxOldGenerationSizeMb };
    }
    if (this.cpuProfileDir) {
      options.execArgv = [...(process.execArgv ?? []), "--cpu-prof", `--cpu-prof-dir=${this.cpuProfileDir}`];
    }
    const worker = new Worker(this.workerPath, options);
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
