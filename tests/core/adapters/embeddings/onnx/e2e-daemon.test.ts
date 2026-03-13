import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OnnxEmbeddings } from "../../../../../src/core/adapters/embeddings/onnx.js";
import { OnnxDaemon } from "../../../../../src/core/adapters/embeddings/onnx/daemon.js";
import type { WorkerRequest, WorkerResponse } from "../../../../../src/core/adapters/embeddings/onnx/worker-types.js";

// ---------------------------------------------------------------------------
// Mock worker — same pattern as daemon.test.ts
// ---------------------------------------------------------------------------

class MockWorker extends EventEmitter {
  postMessage(msg: WorkerRequest): void {
    switch (msg.type) {
      case "init":
        setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
        break;
      case "embed":
        setImmediate(() =>
          this.emit("message", {
            type: "result",
            id: msg.id,
            embeddings: msg.texts.map(() => [1, 2, 3]),
          } satisfies WorkerResponse),
        );
        break;
      case "terminate":
        setImmediate(() => this.emit("exit", 0));
        break;
    }
  }

  async terminate(): Promise<number> {
    this.emit("exit", 0);
    return Promise.resolve(0);
  }
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe("OnnxDaemon E2E", () => {
  let daemon: OnnxDaemon;
  let socketPath: string;
  let pidFile: string;

  beforeEach(() => {
    const id = randomUUID().slice(0, 8);
    socketPath = join(tmpdir(), `tea-rags-e2e-test-${id}.sock`);
    pidFile = join(tmpdir(), `tea-rags-e2e-test-${id}.pid`);
  });

  afterEach(async () => {
    try {
      await daemon?.stop();
    } catch {
      // already stopped
    }
  });

  /**
   * Helper: create an OnnxEmbeddings client pointing at the test daemon socket.
   * Uses default model/dimensions; socketPath is injected so no spawn occurs.
   */
  function createClient(model = "test-model"): OnnxEmbeddings {
    return new OnnxEmbeddings(
      model, // model
      3, // dimensions (MockWorker returns [1,2,3])
      undefined, // cacheDir
      "cpu", // device
      socketPath, // socketPath — daemon is already listening
      undefined, // pidFile
      5_000, // spawnTimeoutMs (unused since daemon already exists)
    );
  }

  it("two clients share one daemon, one disconnects, other still works", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new MockWorker(),
    });

    await daemon.start();

    // 1. Create two clients
    const client1 = createClient();
    const client2 = createClient();

    // 2. Both clients embed successfully
    const result1 = await client1.embed("hello");
    expect(result1.embedding).toEqual([1, 2, 3]);
    expect(result1.dimensions).toBe(3);

    const result2 = await client2.embed("world");
    expect(result2.embedding).toEqual([1, 2, 3]);
    expect(result2.dimensions).toBe(3);

    // 3. Disconnect client1
    await client1.terminate();

    // 4. client2 still works
    const result3 = await client2.embed("still works");
    expect(result3.embedding).toEqual([1, 2, 3]);

    // 5. embedBatch also works on client2
    const batchResults = await client2.embedBatch(["a", "b", "c"]);
    expect(batchResults).toHaveLength(3);
    expect(batchResults[0].embedding).toEqual([1, 2, 3]);

    // 6. Disconnect client2
    await client2.terminate();
  });

  it("daemon shuts down after idle timeout when all clients disconnect", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 200, // Short idle timeout for test
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new MockWorker(),
    });

    await daemon.start();
    expect(existsSync(socketPath)).toBe(true);

    // Connect a client, embed, then disconnect
    const client = createClient();
    const result = await client.embed("test");
    expect(result.embedding).toEqual([1, 2, 3]);

    await client.terminate();

    // Wait for idle timeout to fire (200ms timeout + buffer)
    await new Promise((r) => setTimeout(r, 400));

    // Daemon should have stopped and cleaned up
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("embedBatch with empty array returns empty without connecting", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new MockWorker(),
    });

    await daemon.start();

    const client = createClient();
    const results = await client.embedBatch([]);
    expect(results).toEqual([]);

    // Client never connected to daemon, so terminate is a no-op
    await client.terminate();
  });
});
