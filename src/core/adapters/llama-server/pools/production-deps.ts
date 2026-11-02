// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/** The real process, network and clock side of {@link LlamaServerPoolsDeps}. */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { dirname } from "node:path";

import { isPidAlive } from "../../process-tree/pid-liveness.js";
import { resolveLlamaServerBinary } from "../binary.js";
import { LlamaServerPoolStartError } from "./errors.js";
import type { LlamaServerPoolsDeps } from "./llama-server-pools.js";
import { isLoopbackPortFree } from "./ports.js";

/** Start `binary` in its own process group, detached from this process, appending its output to `logPath`. */
function spawnDetachedLlamaServer(binary: string, args: string[], logPath: string): { pid: number } {
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(binary, args, { detached: true, stdio: ["ignore", logFd, logFd], windowsHide: true });
    // A spawn failure (ENOENT, EACCES) arrives as an async "error" event; the
    // missing pid below reports it, so the event must not crash the process.
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) {
      throw new LlamaServerPoolStartError(`Could not start ${binary}`, `Check that ${binary} exists and is executable`);
    }
    return { pid: child.pid };
  } finally {
    closeSync(logFd);
  }
}

export function productionLlamaServerPoolsDeps(o: {
  dataDir: string;
  env: Record<string, string | undefined>;
  /** Absolute path of `cmd` on PATH, null when absent. */
  which: (cmd: string) => string | null;
}): LlamaServerPoolsDeps {
  return {
    dataDir: o.dataDir,
    resolveBinary: () =>
      resolveLlamaServerBinary({
        env: o.env,
        dataDir: o.dataDir,
        which: o.which,
        exists: existsSync,
        listDir: (p) => readdirSync(p),
      }),
    spawn: spawnDetachedLlamaServer,
    fetch: async (input, init) => fetch(input, init),
    kill: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Already gone between the liveness check and the signal.
      }
    },
    isAlive: isPidAlive,
    isPortFree: isLoopbackPortFree,
    random: Math.random,
    now: Date.now,
    sleep: async (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}
