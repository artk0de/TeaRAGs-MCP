import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { LogContext } from "./debug-logger.js";

// Mock fs module before importing the module under test
vi.mock("node:fs", () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

// Set DEBUG before importing to ensure logger is initialized with DEBUG on
process.env.DEBUG = "true";

// Import after setting DEBUG
const { pipelineLog } = await import("./debug-logger.js");
const fs = await import("node:fs");

describe("DebugLogger", () => {
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  describe("step logging", () => {
    it("should log step messages with component name", () => {
      const ctx: LogContext = { component: "TestComponent" };
      const message = "Test step message";

      pipelineLog.step(ctx, message);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("TestComponent")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(message)
      );
    });

    it("should include optional data in log output", () => {
      const ctx: LogContext = { component: "TestComponent" };
      const data = { key: "value", count: 42 };

      pipelineLog.step(ctx, "With data", data);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(data))
      );
    });

    it("should include timing information in logs", () => {
      const ctx: LogContext = { component: "TestComponent" };
      pipelineLog.step(ctx, "Timed message");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[\+\s*\d+\.\d{3}s\]/)
      );
    });

    it("should write to file system", () => {
      const ctx: LogContext = { component: "TestComponent" };
      pipelineLog.step(ctx, "File test");

      expect(fs.appendFileSync).toHaveBeenCalled();
    });
  });

  describe("batchFormed logging", () => {
    it("should log batch formation with all details", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      pipelineLog.batchFormed(ctx, "batch-123", 50, "size");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("BATCH_FORMED: batch-123")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"items":50')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"trigger":"size"')
      );
    });

    it("should support different trigger types", () => {
      const ctx: LogContext = { component: "BatchProcessor" };

      pipelineLog.batchFormed(ctx, "batch-1", 10, "size");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"trigger":"size"')
      );

      consoleErrorSpy.mockClear();
      pipelineLog.batchFormed(ctx, "batch-2", 20, "timeout");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"trigger":"timeout"')
      );

      consoleErrorSpy.mockClear();
      pipelineLog.batchFormed(ctx, "batch-3", 30, "flush");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"trigger":"flush"')
      );
    });

    it("should increment batch counter", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      const initialCalls = consoleErrorSpy.mock.calls.length;

      pipelineLog.batchFormed(ctx, "batch-counter-1", 10, "size");
      const firstCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0];
      const firstCount = JSON.parse(firstCall.split(" | ")[1]).totalBatches;

      pipelineLog.batchFormed(ctx, "batch-counter-2", 20, "timeout");
      const secondCall = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0];
      const secondCount = JSON.parse(secondCall.split(" | ")[1]).totalBatches;

      expect(secondCount).toBeGreaterThan(firstCount);
    });
  });

  describe("batchStart logging", () => {
    it("should log batch start with item count", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      pipelineLog.batchStart(ctx, "batch-456", 25);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("BATCH_START: batch-456")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"items":25')
      );
    });
  });

  describe("batchComplete logging", () => {
    it("should log batch completion with all metrics", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      pipelineLog.batchComplete(ctx, "batch-789", 30, 1500, 2);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("BATCH_COMPLETE: batch-789")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"items":30')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"durationMs":1500')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"retryCount":2')
      );
    });

    it("should increment chunk counter", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      pipelineLog.batchComplete(ctx, "batch-chunks", 10, 100, 0);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"totalChunks":')
      );
    });
  });

  describe("batchFailed logging", () => {
    it("should log batch failure with retry information", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      pipelineLog.batchFailed(ctx, "batch-fail", "Network error", 1, 3);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("BATCH_FAILED: batch-fail")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"error":"Network error"')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"attempt":1')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"maxRetries":3')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"willRetry":true')
      );
    });

    it("should show willRetry as false when max retries reached", () => {
      const ctx: LogContext = { component: "BatchProcessor" };
      pipelineLog.batchFailed(ctx, "batch-fail-final", "Fatal error", 3, 3);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"willRetry":false')
      );
    });
  });

  describe("queueState logging", () => {
    it("should log queue state with all metrics", () => {
      const ctx: LogContext = { component: "QueueManager" };
      pipelineLog.queueState(ctx, 100, 4, 50);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("QUEUE_STATE")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"queueDepth":100')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"activeWorkers":4')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"pendingItems":50')
      );
    });
  });

  describe("backpressure logging", () => {
    it("should log backpressure on event", () => {
      const ctx: LogContext = { component: "QueueManager" };
      pipelineLog.backpressure(ctx, true, "Queue depth exceeded");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("BACKPRESSURE_ON")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"Queue depth exceeded"')
      );
    });

    it("should log backpressure off event", () => {
      const ctx: LogContext = { component: "QueueManager" };
      pipelineLog.backpressure(ctx, false, "Queue normalized");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("BACKPRESSURE_OFF")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"Queue normalized"')
      );
    });
  });

  describe("embedCall logging", () => {
    it("should log embedding call with duration", () => {
      const ctx: LogContext = { component: "EmbeddingService" };
      pipelineLog.embedCall(ctx, 64, 250);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("EMBED_CALL")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"texts":64')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"durationMs":250')
      );
    });

    it("should work without duration parameter", () => {
      const ctx: LogContext = { component: "EmbeddingService" };
      pipelineLog.embedCall(ctx, 32);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("EMBED_CALL")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"texts":32')
      );
    });

    it("should increment embed call counter", () => {
      const ctx: LogContext = { component: "EmbeddingService" };
      pipelineLog.embedCall(ctx, 16);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"totalCalls":')
      );
    });
  });

  describe("qdrantCall logging", () => {
    it("should log Qdrant call with operation details", () => {
      const ctx: LogContext = { component: "QdrantService" };
      pipelineLog.qdrantCall(ctx, "upsert", 100, 500);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("QDRANT_UPSERT")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"points":100')
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"durationMs":500')
      );
    });

    it("should uppercase operation names", () => {
      const ctx: LogContext = { component: "QdrantService" };

      pipelineLog.qdrantCall(ctx, "delete", 5);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("QDRANT_DELETE")
      );

      consoleErrorSpy.mockClear();
      pipelineLog.qdrantCall(ctx, "search", 10);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("QDRANT_SEARCH")
      );
    });

    it("should increment Qdrant call counter", () => {
      const ctx: LogContext = { component: "QdrantService" };
      pipelineLog.qdrantCall(ctx, "upsert", 50);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"totalCalls":')
      );
    });
  });

  describe("fallback logging", () => {
    it("should log fallback with level and reason", () => {
      const ctx: LogContext = { component: "RetryManager" };
      pipelineLog.fallback(ctx, 2, "Primary endpoint failed");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("FALLBACK_L2")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"Primary endpoint failed"')
      );
    });

    it("should support different fallback levels", () => {
      const ctx: LogContext = { component: "RetryManager" };

      pipelineLog.fallback(ctx, 1, "Level 1");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("FALLBACK_L1")
      );

      consoleErrorSpy.mockClear();
      pipelineLog.fallback(ctx, 3, "Level 3");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("FALLBACK_L3")
      );
    });

    it("should increment fallback counter", () => {
      const ctx: LogContext = { component: "RetryManager" };
      pipelineLog.fallback(ctx, 1, "Timeout");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"totalFallbacks":')
      );
    });
  });

  describe("reindexPhase logging", () => {
    it("should log reindex phase with data", () => {
      pipelineLog.reindexPhase("SCAN", { files: 100 });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Reindex")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("PHASE: SCAN")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"files":100')
      );
    });

    it("should work without data parameter", () => {
      pipelineLog.reindexPhase("COMPLETE");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("PHASE: COMPLETE")
      );
    });

    it("should support various phase names", () => {
      pipelineLog.reindexPhase("START");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("PHASE: START")
      );

      consoleErrorSpy.mockClear();
      pipelineLog.reindexPhase("PROCESS");
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("PHASE: PROCESS")
      );
    });
  });

  describe("summary logging", () => {
    it("should write summary to file with formatted stats", () => {
      const ctx: LogContext = { component: "Pipeline" };
      const stats = {
        totalFiles: 500,
        totalChunks: 2000,
        duration: 60000,
      };

      pipelineLog.summary(ctx, stats);

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("SUMMARY for Pipeline")
      );
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"totalFiles": 500')
      );
      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('"totalChunks": 2000')
      );
    });

    it("should include session counters in summary", () => {
      const ctx: LogContext = { component: "Pipeline" };
      pipelineLog.summary(ctx, {});

      expect(fs.appendFileSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("Session counters:")
      );
    });
  });

  describe("getLogPath", () => {
    it("should return log file path", () => {
      const logPath = pipelineLog.getLogPath();

      expect(logPath).toBeTruthy();
      expect(logPath).toMatch(/pipeline-.*\.log$/);
    });

    it("should return consistent path", () => {
      const path1 = pipelineLog.getLogPath();
      const path2 = pipelineLog.getLogPath();

      expect(path1).toBe(path2);
    });
  });

  describe("error handling", () => {
    it("should handle file write errors gracefully", () => {
      vi.mocked(fs.appendFileSync).mockImplementationOnce(() => {
        throw new Error("Write error");
      });

      const ctx: LogContext = { component: "Test" };

      // Should not throw
      expect(() => {
        pipelineLog.step(ctx, "Test message");
      }).not.toThrow();

      // Console should still be called
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe("log formatting", () => {
    it("should format timestamps with millisecond precision", () => {
      const ctx: LogContext = { component: "Test" };
      pipelineLog.step(ctx, "Message");

      // Should have format like [+   0.123s]
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[\+\s*\d+\.\d{3}s\]/)
      );
    });

    it("should include component name in brackets", () => {
      const ctx: LogContext = { component: "MyComponent" };
      pipelineLog.step(ctx, "Message");

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[MyComponent]")
      );
    });

    it("should format data as JSON with pipe separator", () => {
      const ctx: LogContext = { component: "Test" };
      const data = { nested: { value: 42 } };

      pipelineLog.step(ctx, "Message", data);

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(" | ")
      );
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(JSON.stringify(data))
      );
    });

    it("should not include pipe separator without data", () => {
      const ctx: LogContext = { component: "Test" };
      pipelineLog.step(ctx, "Message");

      const call = consoleErrorSpy.mock.calls[consoleErrorSpy.mock.calls.length - 1][0];
      const parts = call.split(" Message");
      expect(parts[1]).toBe("");
    });
  });
});

describe("DebugLogger - DEBUG environment variable", () => {
  it("should suppress logs when DEBUG is not set", async () => {
    // Reset module cache to allow reimport
    vi.resetModules();

    // Mock fs module again for clean slate
    vi.doMock("node:fs", () => ({
      appendFileSync: vi.fn(),
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
    }));

    // Delete DEBUG env var before importing
    const originalDebug = process.env.DEBUG;
    delete process.env.DEBUG;

    // Import module with DEBUG unset
    const { pipelineLog: noDebugLogger } = await import("./debug-logger.js?t=" + Date.now());
    const fsModule = await import("node:fs");

    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Clear any mocks from module initialization
    vi.clearAllMocks();

    // Attempt to log with DEBUG disabled
    const ctx: LogContext = { component: "TestComponent" };
    noDebugLogger.step(ctx, "should not log");

    // Verify no logging occurred
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(fsModule.appendFileSync).not.toHaveBeenCalled();

    // Cleanup
    consoleErrorSpy.mockRestore();
    process.env.DEBUG = originalDebug;
  });
});
