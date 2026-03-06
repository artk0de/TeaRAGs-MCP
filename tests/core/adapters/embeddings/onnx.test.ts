import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Now import SUT
import {
  DEFAULT_ONNX_DIMENSIONS,
  DEFAULT_ONNX_MODEL,
  OnnxEmbeddings,
} from "../../../../src/core/adapters/embeddings/onnx.js";
import type { WorkerRequest, WorkerResponse } from "../../../../src/core/adapters/embeddings/onnx/worker-types.js";

// --- State shared between mock and tests ---

type MessageHandler = (msg: WorkerResponse) => void;
type ExitHandler = (code: number) => void;

const state = vi.hoisted(() => ({
  messageHandlers: [] as MessageHandler[],
  exitHandlers: [] as ExitHandler[],
  onceExitHandlers: [] as ExitHandler[],
  workerConstructCount: 0,
  postMessageCalls: [] as WorkerRequest[],
  postMessageImpl: null as ((msg: WorkerRequest) => void) | null,
}));

// --- Mock worker_threads (hoisted) ---

vi.mock("node:worker_threads", () => {
  class MockWorker {
    constructor(_path: string) {
      state.workerConstructCount++;
    }

    postMessage(msg: WorkerRequest): void {
      state.postMessageCalls.push(msg);
      state.postMessageImpl?.(msg);
    }

    on(event: string, handler: MessageHandler | ExitHandler): void {
      if (event === "message") state.messageHandlers.push(handler as MessageHandler);
      if (event === "exit") state.exitHandlers.push(handler as ExitHandler);
    }

    once(event: string, handler: ExitHandler): void {
      if (event === "exit") state.onceExitHandlers.push(handler);
    }

    removeListener(event: string, handler: MessageHandler | ExitHandler): void {
      if (event === "message") {
        state.messageHandlers = state.messageHandlers.filter((h) => h !== handler);
      }
      if (event === "exit") {
        state.exitHandlers = state.exitHandlers.filter((h) => h !== handler);
      }
    }

    terminate(): void {
      // no-op
    }
  }

  return { Worker: MockWorker };
});

// --- Helpers ---

function emitMessage(msg: WorkerResponse): void {
  const handlers = [...state.messageHandlers];
  for (const h of handlers) h(msg);
}

function emitExit(code: number): void {
  const handlers = [...state.exitHandlers];
  for (const h of handlers) h(code);
  const once = [...state.onceExitHandlers];
  state.onceExitHandlers = [];
  for (const h of once) h(code);
}

function resetState(): void {
  state.messageHandlers = [];
  state.exitHandlers = [];
  state.onceExitHandlers = [];
  state.workerConstructCount = 0;
  state.postMessageCalls.length = 0;
  state.postMessageImpl = null;
}

/** Set postMessage to auto-respond with ready + embed results */
function autoRespondEmbed(embeddingFactory: (texts: string[]) => number[][]): void {
  state.postMessageImpl = (msg: WorkerRequest) => {
    if (msg.type === "init") {
      queueMicrotask(() => {
        emitMessage({ type: "ready" });
      });
    } else if (msg.type === "embed") {
      const embeddings = embeddingFactory(msg.texts);
      queueMicrotask(() => {
        emitMessage({ type: "result", id: msg.id, embeddings });
      });
    }
  };
}

describe("OnnxEmbeddings (worker proxy)", () => {
  let provider: OnnxEmbeddings;

  beforeEach(() => {
    resetState();
    provider = new OnnxEmbeddings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should return default model", () => {
      expect(provider.getModel()).toBe(DEFAULT_ONNX_MODEL);
    });

    it("should return default dimensions", () => {
      expect(provider.getDimensions()).toBe(DEFAULT_ONNX_DIMENSIONS);
    });

    it("should accept custom model and dimensions", () => {
      const custom = new OnnxEmbeddings("Xenova/all-MiniLM-L6-v2", 384);
      expect(custom.getModel()).toBe("Xenova/all-MiniLM-L6-v2");
      expect(custom.getDimensions()).toBe(384);
    });

    it("should not create worker until needed", () => {
      expect(state.workerConstructCount).toBe(0);
    });
  });

  describe("embed", () => {
    it("should create worker, send init, wait for ready, send embed, return result", async () => {
      const fakeEmbedding = Array.from({ length: 768 }, () => 0.1);
      autoRespondEmbed(() => [fakeEmbedding]);

      const result = await provider.embed("function hello() {}");

      // Worker created
      expect(state.workerConstructCount).toBe(1);

      // Init sent
      const initCall = state.postMessageCalls.find((m) => m.type === "init");
      expect(initCall).toBeDefined();
      expect((initCall as WorkerRequest & { type: "init" }).model).toBe(DEFAULT_ONNX_MODEL);

      // Embed sent
      const embedCall = state.postMessageCalls.find((m) => m.type === "embed");
      expect(embedCall).toBeDefined();

      // Result
      expect(result.embedding).toEqual(fakeEmbedding);
      expect(result.dimensions).toBe(768);
    });

    it("should only create worker once across multiple calls", async () => {
      autoRespondEmbed((texts) => texts.map(() => [0.1]));

      await provider.embed("test1");
      await provider.embed("test2");

      expect(state.workerConstructCount).toBe(1);
    });
  });

  describe("embedBatch", () => {
    it("should return empty array for empty input without creating worker", async () => {
      const result = await provider.embedBatch([]);
      expect(result).toEqual([]);
      expect(state.workerConstructCount).toBe(0);
    });

    it("should delegate to worker and return results", async () => {
      const fakeEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      autoRespondEmbed(() => fakeEmbeddings);

      const results = await provider.embedBatch(["text1", "text2"]);

      expect(results).toHaveLength(2);
      expect(results[0].embedding).toEqual(fakeEmbeddings[0]);
      expect(results[0].dimensions).toBe(768);
      expect(results[1].embedding).toEqual(fakeEmbeddings[1]);
      expect(results[1].dimensions).toBe(768);
    });
  });

  describe("worker crash recovery", () => {
    it("should recreate worker after non-zero exit", async () => {
      autoRespondEmbed((texts) => texts.map(() => [0.1]));

      // First call — creates worker
      await provider.embed("test1");
      expect(state.workerConstructCount).toBe(1);

      // Simulate crash
      emitExit(1);

      // Next call should recreate worker
      await provider.embed("test2");
      expect(state.workerConstructCount).toBe(2);
    });

    it("should log warning on non-zero exit", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      autoRespondEmbed((texts) => texts.map(() => [0.1]));

      await provider.embed("test");
      emitExit(1);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Worker exited with code 1"));
      consoleSpy.mockRestore();
    });
  });

  describe("init error", () => {
    it("should reject when worker responds with error id=-1", async () => {
      state.postMessageImpl = (msg: WorkerRequest) => {
        if (msg.type === "init") {
          queueMicrotask(() => {
            emitMessage({ type: "error", id: -1, message: "Model not found" });
          });
        }
      };

      await expect(provider.embed("test")).rejects.toThrow("Model not found");
    });

    it("should allow retry after init failure", async () => {
      let initCount = 0;
      state.postMessageImpl = (msg: WorkerRequest) => {
        if (msg.type === "init") {
          initCount++;
          if (initCount === 1) {
            queueMicrotask(() => {
              emitMessage({ type: "error", id: -1, message: "Transient error" });
            });
          } else {
            queueMicrotask(() => {
              emitMessage({ type: "ready" });
            });
          }
        } else if (msg.type === "embed") {
          queueMicrotask(() => {
            emitMessage({ type: "result", id: msg.id, embeddings: [[0.1]] });
          });
        }
      };

      await expect(provider.embed("test")).rejects.toThrow("Transient error");

      // Second attempt should succeed (initPromise was cleared)
      const result = await provider.embed("test");
      expect(result.embedding).toEqual([0.1]);
    });
  });

  describe("embed error", () => {
    it("should reject when worker responds with error for request id", async () => {
      state.postMessageImpl = (msg: WorkerRequest) => {
        if (msg.type === "init") {
          queueMicrotask(() => {
            emitMessage({ type: "ready" });
          });
        } else if (msg.type === "embed") {
          queueMicrotask(() => {
            emitMessage({ type: "error", id: msg.id, message: "OOM" });
          });
        }
      };

      await expect(provider.embed("test")).rejects.toThrow("OOM");
    });
  });

  describe("terminate", () => {
    it("should send terminate message and wait for exit", async () => {
      autoRespondEmbed((texts) => texts.map(() => [0.1]));
      await provider.embed("test");

      // Override to handle terminate
      state.postMessageImpl = (msg: WorkerRequest) => {
        if (msg.type === "terminate") {
          queueMicrotask(() => {
            emitExit(0);
          });
        }
      };

      await provider.terminate();

      const terminateCall = state.postMessageCalls.find((m) => m.type === "terminate");
      expect(terminateCall).toBeDefined();
    });

    it("should be a no-op when no worker exists", async () => {
      await provider.terminate(); // Should not throw
      expect(state.workerConstructCount).toBe(0);
    });
  });

  describe("log forwarding", () => {
    it("should forward log messages from worker to console.error", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      autoRespondEmbed((texts) => texts.map(() => [0.1]));

      await provider.embed("test");

      // Simulate worker sending a log message
      emitMessage({ type: "log", level: "error", message: "[ONNX] Loading model..." });

      expect(consoleSpy).toHaveBeenCalledWith("[ONNX] Loading model...");
      consoleSpy.mockRestore();
    });
  });
});
