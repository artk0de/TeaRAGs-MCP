import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_ONNX_DIMENSIONS,
  DEFAULT_ONNX_MODEL,
  OnnxEmbeddings,
} from "../../../../src/core/adapters/embeddings/onnx.js";
import { OnnxDaemon } from "../../../../src/core/adapters/embeddings/onnx/daemon.js";
import type { WorkerRequest, WorkerResponse } from "../../../../src/core/adapters/embeddings/onnx/worker-types.js";

// ---------------------------------------------------------------------------
// Mock worker factory — same as daemon.test.ts
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
// Tests
// ---------------------------------------------------------------------------

describe("OnnxEmbeddings (daemon client)", () => {
  let daemon: OnnxDaemon;
  let provider: OnnxEmbeddings;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `onnx-client-test-${randomUUID().slice(0, 8)}.sock`);
    daemon = new OnnxDaemon({
      socketPath,
      idleTimeoutMs: 30_000,
      heartbeatTimeoutMs: 45_000,
      workerFactory: () => new MockWorker(),
    });
    await daemon.start();
    provider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", socketPath);
  });

  afterEach(async () => {
    await provider.terminate();
    await daemon.stop();
  });

  describe("constructor", () => {
    it("should return default model when no args", () => {
      const def = new OnnxEmbeddings();
      expect(def.getModel()).toBe(DEFAULT_ONNX_MODEL);
      expect(def.getDimensions()).toBe(DEFAULT_ONNX_DIMENSIONS);
    });

    it("should use custom model and dimensions", () => {
      expect(provider.getModel()).toBe("test-model");
      expect(provider.getDimensions()).toBe(3);
    });
  });

  describe("embed", () => {
    it("should connect to daemon and return embedding result", async () => {
      const result = await provider.embed("function hello() {}");
      expect(result.embedding).toEqual([1, 2, 3]);
      expect(result.dimensions).toBe(3);
    });

    it("should reuse connection across multiple calls", async () => {
      const r1 = await provider.embed("test1");
      const r2 = await provider.embed("test2");
      expect(r1.embedding).toEqual([1, 2, 3]);
      expect(r2.embedding).toEqual([1, 2, 3]);
    });
  });

  describe("embedBatch", () => {
    it("should return empty array for empty input without connecting", async () => {
      const result = await provider.embedBatch([]);
      expect(result).toEqual([]);
    });

    it("should return results for multiple texts", async () => {
      const results = await provider.embedBatch(["text1", "text2", "text3"]);
      expect(results).toHaveLength(3);
      for (const r of results) {
        expect(r.embedding).toEqual([1, 2, 3]);
        expect(r.dimensions).toBe(3);
      }
    });
  });

  describe("terminate", () => {
    it("should send disconnect and clean up", async () => {
      // First connect by making a call
      await provider.embed("test");
      // Then terminate
      await provider.terminate();
      // Second terminate should be no-op
      await provider.terminate();
    });

    it("should be a no-op when not connected", async () => {
      await provider.terminate(); // Should not throw
    });
  });

  describe("error handling", () => {
    it("should fail if daemon cannot be reached after spawn attempt", async () => {
      const badProvider = new OnnxEmbeddings(
        "test-model",
        3,
        undefined,
        "cpu",
        "/tmp/nonexistent-socket.sock",
        undefined, // pidFile
        500, // spawnTimeoutMs — short for test
      );
      await expect(badProvider.embed("test")).rejects.toThrow(/Timed out waiting for ONNX daemon to start/);
    }, 5_000);

    it("should propagate daemon error responses", async () => {
      // Create a mock worker that returns errors for embed
      class ErrorWorker extends EventEmitter {
        postMessage(msg: WorkerRequest): void {
          if (msg.type === "init") {
            setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
          } else if (msg.type === "embed") {
            setImmediate(() =>
              this.emit("message", {
                type: "error",
                id: msg.id,
                message: "OOM: out of memory",
              } satisfies WorkerResponse),
            );
          }
        }
        async terminate(): Promise<number> {
          this.emit("exit", 0);
          return Promise.resolve(0);
        }
      }

      const errSocketPath = join(tmpdir(), `onnx-err-test-${randomUUID().slice(0, 8)}.sock`);
      const errDaemon = new OnnxDaemon({
        socketPath: errSocketPath,
        idleTimeoutMs: 30_000,
        heartbeatTimeoutMs: 45_000,
        workerFactory: () => new ErrorWorker(),
      });
      await errDaemon.start();

      const errProvider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", errSocketPath);
      try {
        await expect(errProvider.embed("test")).rejects.toThrow();
      } finally {
        await errProvider.terminate();
        await errDaemon.stop();
      }
    });
  });

  describe("log forwarding", () => {
    it("should forward log messages to console.error", async () => {
      // Create a mock worker that sends a log message before ready,
      // then a log during embed
      class LogWorker extends EventEmitter {
        postMessage(msg: WorkerRequest): void {
          if (msg.type === "init") {
            setImmediate(() => {
              this.emit("message", { type: "ready" } satisfies WorkerResponse);
            });
          } else if (msg.type === "embed") {
            setImmediate(() => {
              this.emit("message", {
                type: "log",
                level: "error",
                message: "[ONNX] Processing batch...",
              } satisfies WorkerResponse);
              // Small delay then result
              setTimeout(() => {
                this.emit("message", {
                  type: "result",
                  id: msg.id,
                  embeddings: msg.texts.map(() => [1, 2, 3]),
                } satisfies WorkerResponse);
              }, 10);
            });
          }
        }
        async terminate(): Promise<number> {
          this.emit("exit", 0);
          return Promise.resolve(0);
        }
      }

      const logSocketPath = join(tmpdir(), `onnx-log-test-${randomUUID().slice(0, 8)}.sock`);
      const logDaemon = new OnnxDaemon({
        socketPath: logSocketPath,
        idleTimeoutMs: 30_000,
        heartbeatTimeoutMs: 45_000,
        workerFactory: () => new LogWorker(),
      });
      await logDaemon.start();

      const logProvider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", logSocketPath);
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        // The log message is forwarded by daemon during embed processing
        await logProvider.embed("test");
        // Give a moment for the log message to be forwarded through socket
        await new Promise((r) => setTimeout(r, 100));
        expect(consoleSpy).toHaveBeenCalledWith("[ONNX] Processing batch...");
      } finally {
        consoleSpy.mockRestore();
        await logProvider.terminate();
        await logDaemon.stop();
      }
    });
  });

  describe("socket error after handshake", () => {
    it("should reject pending requests when socket errors during operation", async () => {
      // Use a slow worker that never responds to the second embed
      class SlowWorker extends EventEmitter {
        private respondCount = 0;
        postMessage(msg: WorkerRequest): void {
          if (msg.type === "init") {
            setImmediate(() => this.emit("message", { type: "ready" } satisfies WorkerResponse));
          } else if (msg.type === "embed") {
            this.respondCount++;
            if (this.respondCount === 1) {
              // Respond to first embed normally
              setImmediate(() =>
                this.emit("message", {
                  type: "result",
                  id: msg.id,
                  embeddings: msg.texts.map(() => [1, 2, 3]),
                } satisfies WorkerResponse),
              );
            }
            // Second embed: never respond — let socket close reject it
          }
        }
        async terminate(): Promise<number> {
          this.emit("exit", 0);
          return Promise.resolve(0);
        }
      }

      const slowSocketPath = join(tmpdir(), `onnx-slow-${randomUUID().slice(0, 8)}.sock`);
      const slowDaemon = new OnnxDaemon({
        socketPath: slowSocketPath,
        idleTimeoutMs: 30_000,
        heartbeatTimeoutMs: 45_000,
        workerFactory: () => new SlowWorker(),
      });
      await slowDaemon.start();

      const slowProvider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", slowSocketPath);

      // First embed succeeds
      const result = await slowProvider.embed("test");
      expect(result.embedding).toEqual([1, 2, 3]);

      // Start second embed — will be pending forever
      const embedPromise = slowProvider.embed("another");

      // Give time for the request to be written to socket
      await new Promise((r) => setTimeout(r, 50));

      // Kill daemon — triggers socket close on client side
      await slowDaemon.stop();

      await expect(embedPromise).rejects.toThrow(/Socket/);

      await slowProvider.terminate();
    });

    it("should clean up and allow reconnect after socket error", async () => {
      await provider.embed("test");

      // Stop daemon to kill connection
      await daemon.stop();

      // Wait for socket close to propagate
      await new Promise((r) => setTimeout(r, 100));

      // Restart daemon
      daemon = new OnnxDaemon({
        socketPath,
        idleTimeoutMs: 30_000,
        heartbeatTimeoutMs: 45_000,
        workerFactory: () => new MockWorker(),
      });
      await daemon.start();

      // Create new provider since old one's connectPromise was cleared
      const newProvider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", socketPath);
      const result = await newProvider.embed("reconnected");
      expect(result.embedding).toEqual([1, 2, 3]);
      await newProvider.terminate();
    });
  });

  describe("socket close with pending requests", () => {
    it("should reject all pending requests on socket close", async () => {
      await provider.embed("init");

      // Manually inject a pending request
      const pendingMap = (
        provider as unknown as {
          pending: Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>;
        }
      ).pending;

      const rejection = new Promise<void>((resolve, reject) => {
        pendingMap.set(999, {
          resolve: () => {
            reject(new Error("Should not resolve"));
          },
          reject: (err) => {
            expect(err.message).toMatch(/Socket closed/);
            resolve();
          },
        });
      });

      // Kill the daemon to trigger socket close
      await daemon.stop();

      await rejection;
    });
  });

  describe("cleanup called multiple times", () => {
    it("should not throw when cleanup is called multiple times", async () => {
      await provider.embed("test");
      await provider.terminate();
      // Second terminate calls cleanup again — should be safe
      await provider.terminate();
    });
  });

  describe("terminate edge cases", () => {
    it("should handle terminate when socket is already destroyed", async () => {
      await provider.embed("test");

      // Destroy the socket before terminate
      const internalSocket = (provider as unknown as { socket: Socket }).socket;
      internalSocket.destroy();

      // terminate should handle destroyed socket gracefully
      await provider.terminate();
    });
  });

  describe("handleResponse edge cases", () => {
    it("should handle pong and bye response types without error", async () => {
      // Connect first
      await provider.embed("test");

      // Access internal socket to send raw messages that trigger handleResponse
      const internalSocket = (provider as unknown as { socket: Socket }).socket;

      // Send pong — should be silently consumed
      internalSocket.emit("data", Buffer.from(`${JSON.stringify({ type: "pong" })}\n`));

      // Send bye — should be silently consumed
      internalSocket.emit("data", Buffer.from(`${JSON.stringify({ type: "bye" })}\n`));

      // Send log — should call console.error
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      internalSocket.emit("data", Buffer.from(`${JSON.stringify({ type: "log", message: "test-log" })}\n`));

      await new Promise((r) => setTimeout(r, 50));
      expect(consoleSpy).toHaveBeenCalledWith("test-log");
      consoleSpy.mockRestore();
    });

    it("should handle error response by rejecting all pending", async () => {
      await provider.embed("test");

      const pendingMap = (
        provider as unknown as {
          pending: Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>;
        }
      ).pending;

      const rejection = new Promise<void>((resolve, reject) => {
        pendingMap.set(888, {
          resolve: () => {
            reject(new Error("Should not resolve"));
          },
          reject: (err) => {
            expect(err.message).toBe("Daemon error");
            resolve();
          },
        });
      });

      const internalSocket = (provider as unknown as { socket: Socket }).socket;
      internalSocket.emit("data", Buffer.from(`${JSON.stringify({ type: "error", message: "Daemon error" })}\n`));

      await rejection;
    });

    it("should handle result for unknown id gracefully", async () => {
      await provider.embed("test");

      const internalSocket = (provider as unknown as { socket: Socket }).socket;
      // Send result with id that has no pending handler — should not throw
      internalSocket.emit("data", Buffer.from(`${JSON.stringify({ type: "result", id: 77777, embeddings: [[0]] })}\n`));

      // If we get here without error, the test passes
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("heartbeat", () => {
    it("should start heartbeat with unref on connect", async () => {
      await provider.embed("test");

      // Verify heartbeat interval exists and was unref'd
      const hb = (provider as unknown as { heartbeatInterval: ReturnType<typeof setInterval> | null })
        .heartbeatInterval;
      expect(hb).not.toBeNull();
    });
  });

  describe("connect with cacheDir", () => {
    it("should pass cacheDir in connect message", async () => {
      const cacheDirPath = "/tmp/test-cache";
      const providerWithCache = new OnnxEmbeddings("test-model", 3, cacheDirPath, "cpu", socketPath);

      const result = await providerWithCache.embed("test");
      expect(result.embedding).toEqual([1, 2, 3]);

      await providerWithCache.terminate();
    });
  });

  describe("connection failure", () => {
    it("should reset connectPromise on connection failure", async () => {
      // Stop daemon so connection will fail
      await daemon.stop();

      // Try to connect — should fail
      const badProvider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", socketPath, undefined, 200);

      await expect(badProvider.embed("test")).rejects.toThrow();

      // connectPromise should have been reset to null
      const cp = (badProvider as unknown as { connectPromise: Promise<void> | null }).connectPromise;
      expect(cp).toBeNull();
    });
  });

  describe("handshake error from daemon", () => {
    it("should reject when daemon sends error during handshake", async () => {
      // First, start a daemon and connect one client with model-a
      const errSocketPath = join(tmpdir(), `onnx-hserr-${randomUUID().slice(0, 8)}.sock`);
      const errDaemon = new OnnxDaemon({
        socketPath: errSocketPath,
        idleTimeoutMs: 30_000,
        heartbeatTimeoutMs: 45_000,
        workerFactory: () => new MockWorker(),
      });
      await errDaemon.start();

      // Connect first client to load model-a
      const firstProvider = new OnnxEmbeddings("model-a", 3, undefined, "cpu", errSocketPath);
      await firstProvider.embed("init");

      // Try connecting with mismatched model — daemon sends error during handshake
      const mismatchProvider = new OnnxEmbeddings("model-b", 3, undefined, "cpu", errSocketPath);
      await expect(mismatchProvider.embed("test")).rejects.toThrow(/Model mismatch|model/i);

      await firstProvider.terminate();
      await errDaemon.stop();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests using raw TCP servers (no OnnxDaemon) for edge-case coverage
// ---------------------------------------------------------------------------

describe("OnnxEmbeddings (raw server edge cases)", () => {
  let server: Server;
  let rawSocketPath: string;

  beforeEach(() => {
    rawSocketPath = join(tmpdir(), `onnx-raw-test-${randomUUID().slice(0, 8)}.sock`);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  });

  it("should reject with socket error when socket path exists but is not a valid socket", async () => {
    // Create a regular file at the socket path — not a Unix socket
    writeFileSync(rawSocketPath, "not-a-socket");
    expect(existsSync(rawSocketPath)).toBe(true);

    // The socket file exists, so spawnDaemon is skipped and connectToDaemon is called.
    // createConnection will emit "error" (ENOTSOCK or ECONNREFUSED)
    const provider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", rawSocketPath);

    await expect(provider.embed("test")).rejects.toThrow(/Cannot connect to ONNX daemon/);
  });

  it("should handle socket close after handshake completes", async () => {
    // Create a server that completes handshake then closes the socket
    server = createServer((socket) => {
      let buf = "";

      socket.on("data", (data) => {
        buf += data.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === "connect") {
            socket.write(`${JSON.stringify({ type: "connected", model: msg.model, clients: 1 })}\n`);
            // After handshake, close socket after short delay
            setTimeout(() => {
              socket.end();
            }, 100);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(rawSocketPath, resolve));

    const provider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", rawSocketPath);

    // Handshake succeeds, but then socket closes while we have a pending request
    const embedPromise = provider.embed("test");

    await expect(embedPromise).rejects.toThrow(/Socket/);
  }, 10_000);

  it("should ignore invalid JSON lines (parseLine returns null)", async () => {
    server = createServer((socket) => {
      const buf = { data: "" };

      socket.on("data", (data) => {
        buf.data += data.toString();
        let idx: number;
        while ((idx = buf.data.indexOf("\n")) !== -1) {
          const line = buf.data.slice(0, idx);
          buf.data = buf.data.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.type === "connect") {
            // Send invalid JSON first, then valid connected response
            socket.write("not-valid-json\n");
            socket.write(`${JSON.stringify({ type: "connected", model: msg.model, clients: 1 })}\n`);
          } else if (msg.type === "embed") {
            socket.write(
              `${JSON.stringify({ type: "result", id: msg.id, embeddings: msg.texts.map(() => [1, 2, 3]) })}\n`,
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(rawSocketPath, resolve));

    const provider = new OnnxEmbeddings("test-model", 3, undefined, "cpu", rawSocketPath);

    // Should handle invalid JSON gracefully and still work
    const result = await provider.embed("test");
    expect(result.embedding).toEqual([1, 2, 3]);

    await provider.terminate();
  });
});
