import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import { OnnxDaemon } from "../../../../src/core/adapters/embeddings/onnx/daemon.js";
import type { WorkerRequest, WorkerResponse } from "../../../../src/core/adapters/embeddings/onnx/worker-types.js";
import {
  DEFAULT_ONNX_DIMENSIONS,
  DEFAULT_ONNX_MODEL,
  OnnxEmbeddings,
} from "../../../../src/core/adapters/embeddings/onnx.js";

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

  terminate(): Promise<number> {
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
    it("should throw when daemon socket does not exist", async () => {
      const badProvider = new OnnxEmbeddings(
        "test-model",
        3,
        undefined,
        "cpu",
        "/tmp/nonexistent-socket.sock",
      );
      await expect(badProvider.embed("test")).rejects.toThrow();
    });

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
        terminate(): Promise<number> {
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
              this.emit("message", { type: "log", level: "error", message: "[ONNX] Processing batch..." } satisfies WorkerResponse);
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
        terminate(): Promise<number> {
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
});
