import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OnnxEmbeddings } from "../../../../src/core/adapters/embeddings/onnx.js";
import { OnnxDaemon } from "../../../../src/core/adapters/embeddings/onnx/daemon.js";
import { OnnxModelLoadError } from "../../../../src/core/adapters/embeddings/onnx/errors.js";
import type { WorkerRequest, WorkerResponse } from "../../../../src/core/adapters/embeddings/onnx/worker-types.js";

class MockWorker extends EventEmitter {
  postMessage(msg: WorkerRequest): void {
    if (msg.type === "init") setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
    if (msg.type === "embed") {
      setImmediate(() =>
        this.emit("message", {
          type: "result",
          id: msg.id,
          embeddings: msg.texts.map(() => [1, 2, 3]),
          durationMs: 0,
        } satisfies WorkerResponse),
      );
    }
    if (msg.type === "terminate") setImmediate(() => this.emit("exit", 0));
  }

  async terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

// A dead PID no real process holds (above the macOS / Linux pid ceilings).
const DEAD_PID = "2147483000";

describe("OnnxEmbeddings stale daemon socket recovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onnx-stale-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function staleCase(pidFileContent: string | null) {
    const socketPath = join(dir, `s-${randomUUID().slice(0, 6)}.sock`);
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(socketPath, "");
    if (pidFileContent !== null) writeFileSync(pidFile, pidFileContent);
    // Short spawn timeout: the stale files are swept, a respawn is attempted, and the client gives up.
    const provider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", socketPath, pidFile, 300);
    return { socketPath, pidFile, provider };
  }

  it.each([
    ["has no pid file", null],
    ["names a pid that no longer runs", DEAD_PID],
    ["holds a pid file that is not a number", "not-a-pid"],
  ])(
    "sweeps a leftover socket whose daemon %s before respawning",
    async (_label, pidContent) => {
      const { socketPath, pidFile, provider } = staleCase(pidContent);
      await expect(provider.embed("x")).rejects.toThrow(OnnxModelLoadError);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFile)).toBe(false);
      await provider.terminate();
    },
    10_000,
  );

  it("keeps the socket of a daemon whose pid is alive and connects to it", async () => {
    const socketPath = join(dir, `live-${randomUUID().slice(0, 6)}.sock`);
    const pidFile = join(dir, "live.pid");
    const daemon = new OnnxDaemon({
      socketPath,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new MockWorker(),
    });
    await daemon.start();
    writeFileSync(pidFile, String(process.pid));
    const provider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", socketPath, pidFile, 300);
    try {
      // The socket survives the staleness probe: the client reaches the live daemon instead of respawning.
      const result = await provider.embed("x");
      expect(result.embedding).toEqual([1, 2, 3]);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      await provider.terminate();
      await daemon.stop();
    }
  }, 10_000);
});
