import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { OnnxDaemon } from "../../../../../src/core/adapters/embeddings/onnx/daemon.js";
import { LineSplitter } from "../../../../../src/core/adapters/embeddings/onnx/line-splitter.js";
import {
  serialize,
  parseLine,
  type DaemonRequest,
  type DaemonResponse,
} from "../../../../../src/core/adapters/embeddings/onnx/daemon-types.js";

// ---------------------------------------------------------------------------
// Mock worker factory — simulates worker thread via EventEmitter
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";
import type { WorkerRequest, WorkerResponse } from "../../../../../src/core/adapters/embeddings/onnx/worker-types.js";

class MockWorker extends EventEmitter {
  postMessage(msg: WorkerRequest): void {
    switch (msg.type) {
      case "init":
        // Simulate async ready
        setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
        break;
      case "embed":
        // Return fake embeddings: one vector of [1,2,3] per text
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

function createMockWorkerFactory(): () => MockWorker {
  return () => new MockWorker();
}

// ---------------------------------------------------------------------------
// Test helper: connect to daemon, send messages, collect responses
// ---------------------------------------------------------------------------

async function connectAndSend(
  socketPath: string,
  messages: DaemonRequest[],
  expectedResponses: number,
): Promise<DaemonResponse[]> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath);
    const responses: DaemonResponse[] = [];
    const splitter = new LineSplitter();
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error(`Timed out waiting for ${expectedResponses} responses, got ${responses.length}: ${JSON.stringify(responses)}`));
    }, 5000);

    splitter.onLine((line) => {
      const parsed = parseLine(line);
      if (parsed) responses.push(parsed as DaemonResponse);
      if (responses.length === expectedResponses) {
        clearTimeout(timeout);
        client.end();
        resolve(responses);
      }
    });

    client.on("data", (data) => { splitter.feed(data.toString()); });
    client.on("error", reject);
    client.on("connect", () => {
      for (const msg of messages) {
        client.write(serialize(msg));
      }
    });
  });
}

/** Keep a persistent connection for multi-step interactions */
function createPersistentClient(socketPath: string) {
  const client = createConnection(socketPath);
  const splitter = new LineSplitter();
  const responseQueue: DaemonResponse[] = [];
  let waitResolve: ((resp: DaemonResponse) => void) | null = null;

  splitter.onLine((line) => {
    const parsed = parseLine(line);
    if (parsed) {
      const resp = parsed as DaemonResponse;
      if (waitResolve) {
        const r = waitResolve;
        waitResolve = null;
        r(resp);
      } else {
        responseQueue.push(resp);
      }
    }
  });

  client.on("data", (data) => { splitter.feed(data.toString()); });

  async function waitForResponse(): Promise<DaemonResponse> {
    if (responseQueue.length > 0) {
      return Promise.resolve(responseQueue.shift()!);
    }
    return new Promise((resolve) => {
      waitResolve = resolve;
    });
  }

  return {
    send(msg: DaemonRequest): void {
      client.write(serialize(msg));
    },
    waitForResponse,
    async close(): Promise<void> {
      return new Promise((resolve) => {
        client.on("close", resolve);
        client.end();
      });
    },
    get socket() {
      return client;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OnnxDaemon", () => {
  let daemon: OnnxDaemon;
  let socketPath: string;
  let pidFile: string;

  beforeEach(() => {
    const id = randomUUID().slice(0, 8);
    socketPath = join(tmpdir(), `tea-rags-daemon-test-${id}.sock`);
    pidFile = join(tmpdir(), `tea-rags-daemon-test-${id}.pid`);
  });

  afterEach(async () => {
    try {
      await daemon?.stop();
    } catch {
      // already stopped
    }
  });

  it("should start and respond to status with 0 clients", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // PID file should exist
    expect(existsSync(pidFile)).toBe(true);
    const pid = readFileSync(pidFile, "utf-8").trim();
    expect(Number(pid)).toBe(process.pid);

    const responses = await connectAndSend(socketPath, [{ type: "status" }], 1);
    expect(responses[0]).toMatchObject({
      type: "status",
      clients: 0,
      model: "",
    });
  });

  it("should accept connect and return connected response", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });

    const resp = await client.waitForResponse();
    expect(resp).toMatchObject({ type: "connected", model: "test-model", clients: 1 });

    await client.close();
  });

  it("should handle connect + embed and return result", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const client = createPersistentClient(socketPath);

    client.send({ type: "connect", model: "test-model", device: "cpu" });
    const connectResp = await client.waitForResponse();
    expect(connectResp.type).toBe("connected");

    client.send({ type: "embed", id: 1, texts: ["hello", "world"] });
    const embedResp = await client.waitForResponse();
    expect(embedResp).toMatchObject({
      type: "result",
      id: 1,
      embeddings: [[1, 2, 3], [1, 2, 3]],
    });

    await client.close();
  });

  it("should reject connect with mismatched model", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // First client connects with model-a
    const client1 = createPersistentClient(socketPath);
    client1.send({ type: "connect", model: "model-a", device: "cpu" });
    const resp1 = await client1.waitForResponse();
    expect(resp1.type).toBe("connected");

    // Second client tries model-b
    const client2 = createPersistentClient(socketPath);
    client2.send({ type: "connect", model: "model-b", device: "cpu" });
    const resp2 = await client2.waitForResponse();
    expect(resp2).toMatchObject({
      type: "error",
      message: expect.stringContaining("model-a"),
    });

    await client1.close();
    await client2.close();
  });

  it("should accept second client with same model and increment refcount", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const client1 = createPersistentClient(socketPath);
    client1.send({ type: "connect", model: "test-model", device: "cpu" });
    const resp1 = await client1.waitForResponse();
    expect(resp1).toMatchObject({ type: "connected", clients: 1 });

    const client2 = createPersistentClient(socketPath);
    client2.send({ type: "connect", model: "test-model", device: "cpu" });
    const resp2 = await client2.waitForResponse();
    expect(resp2).toMatchObject({ type: "connected", clients: 2 });

    await client1.close();
    await client2.close();
  });

  it("should respond to shutdown with bye and stop", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const responses = await connectAndSend(socketPath, [{ type: "shutdown" }], 1);
    expect(responses[0]).toMatchObject({ type: "bye" });

    // Give daemon time to clean up
    await new Promise((r) => setTimeout(r, 100));

    // Socket file should be cleaned up
    expect(existsSync(socketPath)).toBe(false);
  });

  it("should decrement refcount on client disconnect", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // Connect two clients
    const client1 = createPersistentClient(socketPath);
    client1.send({ type: "connect", model: "test-model", device: "cpu" });
    await client1.waitForResponse();

    const client2 = createPersistentClient(socketPath);
    client2.send({ type: "connect", model: "test-model", device: "cpu" });
    await client2.waitForResponse();

    // Disconnect client1 explicitly
    client1.send({ type: "disconnect" });
    const byeResp = await client1.waitForResponse();
    expect(byeResp).toMatchObject({ type: "bye" });
    await client1.close();

    // Wait for daemon to process
    await new Promise((r) => setTimeout(r, 50));

    // Check status — should have 1 client
    const statusClient = createPersistentClient(socketPath);
    statusClient.send({ type: "status" });
    const statusResp = await statusClient.waitForResponse();
    expect(statusResp).toMatchObject({ type: "status", clients: 1 });

    await statusClient.close();
    await client2.close();
  });

  it("should handle socket close as implicit disconnect", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    // Close socket without sending disconnect
    await client.close();

    // Wait for daemon to detect close
    await new Promise((r) => setTimeout(r, 100));

    // Status should show 0 clients
    const statusClient = createPersistentClient(socketPath);
    statusClient.send({ type: "status" });
    const statusResp = await statusClient.waitForResponse();
    expect(statusResp).toMatchObject({ type: "status", clients: 0 });

    await statusClient.close();
  });

  it("should respond to heartbeat with pong", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const responses = await connectAndSend(socketPath, [{ type: "heartbeat" }], 1);
    expect(responses[0]).toMatchObject({ type: "pong" });
  });

  it("should clean up socket file on stop()", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFile)).toBe(true);

    await daemon.stop();

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("should shut down after idle timeout when last client disconnects", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 200, // Short timeout for test
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // Connect then disconnect
    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    client.send({ type: "disconnect" });
    await client.waitForResponse();
    await client.close();

    // Wait for idle timeout to fire
    await new Promise((r) => setTimeout(r, 400));

    // Socket should be cleaned up
    expect(existsSync(socketPath)).toBe(false);
  });

  it("should error on embed without connect", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const responses = await connectAndSend(
      socketPath,
      [{ type: "embed", id: 1, texts: ["hello"] }],
      1,
    );
    expect(responses[0]).toMatchObject({
      type: "error",
      message: expect.stringContaining("not connected"),
    });
  });

  it("should clean up stale socket file on start", async () => {
    // Pre-create a stale socket file
    writeFileSync(socketPath, "stale");
    expect(existsSync(socketPath)).toBe(true);

    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // Daemon should have removed old file and created a new socket
    const responses = await connectAndSend(socketPath, [{ type: "status" }], 1);
    expect(responses[0]).toMatchObject({ type: "status" });
  });

  it("should handle worker error event", async () => {
    let workerInstance: MockWorker | null = null;
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => {
        workerInstance = new MockWorker();
        return workerInstance;
      },
    });

    await daemon.start();

    // Connect a client to trigger worker spawn
    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    // Simulate worker error — should log but not crash
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    workerInstance!.emit("error", new Error("Worker crashed"));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Worker crashed"));
    consoleSpy.mockRestore();

    await client.close();
  });

  it("should handle worker exit event", async () => {
    let workerInstance: MockWorker | null = null;
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => {
        workerInstance = new MockWorker();
        return workerInstance;
      },
    });

    await daemon.start();

    // Connect to spawn worker
    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    // Simulate worker exit
    workerInstance!.emit("exit", 1);

    // After exit, embed should fail (worker is null)
    client.send({ type: "embed", id: 1, texts: ["hello"] });
    const resp = await client.waitForResponse();
    expect(resp).toMatchObject({
      type: "error",
      message: expect.stringContaining("not connected"),
    });

    await client.close();
  });

  it("should disconnect client when heartbeat times out", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 200, // Very short timeout for test
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // Connect a client
    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    // Don't send heartbeats — wait for timeout to fire
    await new Promise((r) => setTimeout(r, 400));

    // Check status — client should have been disconnected
    const statusClient = createPersistentClient(socketPath);
    statusClient.send({ type: "status" });
    const statusResp = await statusClient.waitForResponse();
    expect(statusResp).toMatchObject({ type: "status", clients: 0 });

    await statusClient.close();
    // Original client socket is already destroyed by daemon
    client.socket.destroy();
  });

  it("should forward worker error response to client", async () => {
    class ErrorOnEmbedWorker extends EventEmitter {
      postMessage(msg: WorkerRequest): void {
        if (msg.type === "init") {
          setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
        } else if (msg.type === "embed") {
          setImmediate(() =>
            this.emit("message", {
              type: "error",
              id: msg.id,
              message: "ONNX runtime error",
            } satisfies WorkerResponse),
          );
        }
      }
      async terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
    }

    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new ErrorOnEmbedWorker(),
    });

    await daemon.start();

    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    client.send({ type: "embed", id: 42, texts: ["test"] });
    const resp = await client.waitForResponse();
    expect(resp).toMatchObject({ type: "error", message: "ONNX runtime error" });

    await client.close();
  });

  it("should handle socket error on client connection", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    await client.waitForResponse();

    // Force close without graceful disconnect — triggers the close handler
    client.socket.destroy();

    await new Promise((r) => setTimeout(r, 100));

    // Check status — close should have disconnected the client
    const statusClient = createPersistentClient(socketPath);
    statusClient.send({ type: "status" });
    const statusResp = await statusClient.waitForResponse();
    expect(statusResp).toMatchObject({ type: "status", clients: 0 });

    await statusClient.close();
  });

  it("should handle stop() called twice", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();
    await daemon.stop();
    // Second stop should be a no-op
    await daemon.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("should forward worker log messages to connected clients", async () => {
    class LogWorker extends EventEmitter {
      postMessage(msg: WorkerRequest): void {
        if (msg.type === "init") {
          setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
        } else if (msg.type === "embed") {
          // Emit log first, then result
          setImmediate(() => {
            this.emit("message", { type: "log", level: "info", message: "Processing batch..." } satisfies WorkerResponse);
            setTimeout(() =>
              this.emit("message", {
                type: "result",
                id: msg.id,
                embeddings: msg.texts.map(() => [1, 2, 3]),
              } satisfies WorkerResponse), 10);
          });
        }
      }
      async terminate(): Promise<number> {
        this.emit("exit", 0);
        return Promise.resolve(0);
      }
    }

    daemon = new OnnxDaemon({
      socketPath,
      pidFile,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new LogWorker(),
    });

    await daemon.start();

    const client = createPersistentClient(socketPath);
    client.send({ type: "connect", model: "test-model", device: "cpu" });
    const connectResp = await client.waitForResponse();
    expect(connectResp.type).toBe("connected");

    // Send embed — worker will emit log then result
    client.send({ type: "embed", id: 1, texts: ["hello"] });

    const resp1 = await client.waitForResponse();
    const resp2 = await client.waitForResponse();

    const responses = [resp1, resp2];
    const hasLog = responses.some((r) => r.type === "log");
    const hasResult = responses.some((r) => r.type === "result");
    expect(hasLog).toBe(true);
    expect(hasResult).toBe(true);

    await client.close();
  });

  it("should start without pidFile config", async () => {
    daemon = new OnnxDaemon({
      socketPath,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: createMockWorkerFactory(),
    });

    await daemon.start();

    // Should work fine without pidFile
    const responses = await connectAndSend(socketPath, [{ type: "status" }], 1);
    expect(responses[0]).toMatchObject({ type: "status" });
  });
});
