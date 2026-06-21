import { fork } from "node:child_process";

import { INIT_KEY } from "./worker-runtime.js";
import { SHUTDOWN_MESSAGE, type WorkerHandle, type WorkerTransport } from "./worker-transport.js";

/**
 * child_process.fork transport. Each worker is a separate OS process with its
 * OWN dlopen of node-tree-sitter, so concurrent parses cannot share native
 * statics — the isolation node:worker_threads cannot provide. `init` is sent as
 * the first IPC message under INIT_KEY (fork has no workerData). Messaging is
 * Node IPC (JSON serialization); the wire protocol is already JSON-safe.
 */
export class ProcessTransport<Req, Res> implements WorkerTransport<Req, Res> {
  constructor(private readonly workerPath: string) {}

  spawn(init: unknown): WorkerHandle<Req, Res> {
    const child = fork(this.workerPath, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.send({ [INIT_KEY]: init });
    return {
      post: (request) => child.send(request as object),
      onMessage: (cb) =>
        child.on("message", (m) => {
          cb(m as Res | { error: string });
        }),
      onError: (cb) => child.on("error", cb),
      onExit: (cb) =>
        child.once("exit", () => {
          cb();
        }),
      shutdown: () => {
        child.unref();
        child.send(SHUTDOWN_MESSAGE);
      },
      terminate: async () => {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => {
            child.once("exit", () => {
              resolve();
            });
            child.kill("SIGKILL");
          });
        }
      },
    };
  }
}
