import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import type { LogContext, PipelineStage } from "./debug-logger.js";

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

describe("Stage Profiling", () => {
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.clearAllMocks();
    pipelineLog.resetProfiler();
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("should track time with addStageTime", () => {
    pipelineLog.addStageTime("embed", 1000);
    pipelineLog.addStageTime("embed", 2000);
    pipelineLog.addStageTime("qdrant", 500);

    const summary = pipelineLog.getStageSummary();

    expect(summary.embed.totalMs).toBe(3000);
    expect(summary.embed.count).toBe(2);
    expect(summary.qdrant.totalMs).toBe(500);
    expect(summary.qdrant.count).toBe(1);
  });

  it("should track time with startStage/endStage", async () => {
    pipelineLog.stageStart("scan");
    await new Promise(resolve => setTimeout(resolve, 20));
    pipelineLog.stageEnd("scan");

    const summary = pipelineLog.getStageSummary();
    expect(summary.scan.totalMs).toBeGreaterThanOrEqual(15);
    expect(summary.scan.count).toBe(1);
  });

  it("should calculate percentages correctly", () => {
    pipelineLog.addStageTime("scan", 100);
    pipelineLog.addStageTime("parse", 200);
    pipelineLog.addStageTime("embed", 700);

    const summary = pipelineLog.getStageSummary();

    expect(summary.scan.percentage).toBeCloseTo(10, 0);
    expect(summary.parse.percentage).toBeCloseTo(20, 0);
    expect(summary.embed.percentage).toBeCloseTo(70, 0);
  });

  it("should only include stages with recorded time", () => {
    pipelineLog.addStageTime("embed", 500);

    const summary = pipelineLog.getStageSummary();

    expect(summary.embed).toBeDefined();
    expect(summary.scan).toBeUndefined();
    expect(summary.git).toBeUndefined();
  });

  it("should reset profiler", () => {
    pipelineLog.addStageTime("embed", 1000);
    pipelineLog.resetProfiler();

    const summary = pipelineLog.getStageSummary();
    expect(Object.keys(summary)).toHaveLength(0);
  });

  it("should track wall time for addStageTime with overlapping intervals", async () => {
    // addStageTime assumes work just finished at "now", so intervals are [now-duration, now]
    // First call: [t0-500, t0]
    // Wait 50ms
    // Second call: [t1-500, t1] where t1 = t0+50
    // These intervals overlap! [t0-500, t0] and [t0-450, t0+50] merge to [t0-500, t0+50] = 550ms
    pipelineLog.addStageTime("git", 500);
    await new Promise(resolve => setTimeout(resolve, 50));
    pipelineLog.addStageTime("git", 500);

    const summary = pipelineLog.getStageSummary();

    // Cumulative: 1000ms (sum of durations)
    expect(summary.git.totalMs).toBe(1000);
    // Wall time: ~550ms (merged overlapping intervals)
    expect(summary.git.wallMs).toBeGreaterThanOrEqual(500);
    expect(summary.git.wallMs).toBeLessThan(700);
  });

  it("should merge overlapping intervals for wall time", async () => {
    // Simulate overlapping parallel work
    // Worker 1: starts at 0, duration 100ms -> interval [0, 100]
    // Worker 2: starts at 20ms, duration 100ms -> interval [20, 120]
    // Merged wall time should be ~120ms, not 200ms
    pipelineLog.stageStart("parse");
    await new Promise(resolve => setTimeout(resolve, 20));
    pipelineLog.stageStart("parse"); // overlapping start
    await new Promise(resolve => setTimeout(resolve, 80));
    pipelineLog.stageEnd("parse"); // first ends at ~100
    await new Promise(resolve => setTimeout(resolve, 20));
    pipelineLog.stageEnd("parse"); // second ends at ~120

    const summary = pipelineLog.getStageSummary();

    // Cumulative: ~200ms (100 + 100)
    expect(summary.parse.totalMs).toBeGreaterThanOrEqual(150);
    // Wall time: ~120ms (merged overlapping intervals)
    expect(summary.parse.wallMs).toBeGreaterThanOrEqual(100);
    expect(summary.parse.wallMs).toBeLessThan(summary.parse.totalMs);
  });

  it("should track wall time for startStage/endStage calls", async () => {
    pipelineLog.stageStart("parse");
    await new Promise(resolve => setTimeout(resolve, 30));
    pipelineLog.stageEnd("parse");

    pipelineLog.stageStart("parse");
    await new Promise(resolve => setTimeout(resolve, 30));
    pipelineLog.stageEnd("parse");

    const summary = pipelineLog.getStageSummary();

    // Cumulative: ~60ms (two 30ms calls)
    expect(summary.parse.totalMs).toBeGreaterThanOrEqual(40);
    // Wall time: ~60ms (two non-overlapping intervals)
    expect(summary.parse.wallMs).toBeGreaterThanOrEqual(40);
  });

  it("should report wallMs equal to totalMs for single call", () => {
    pipelineLog.addStageTime("qdrant", 500);

    const summary = pipelineLog.getStageSummary();

    // Single call = wall time equals cumulative
    expect(summary.qdrant.wallMs).toBe(500);
  });

  it("should reset wall time on profiler reset", () => {
    pipelineLog.addStageTime("embed", 1000);
    pipelineLog.resetProfiler();

    pipelineLog.addStageTime("embed", 500);
    const summary = pipelineLog.getStageSummary();
    expect(summary.embed.totalMs).toBe(500);
    expect(summary.embed.wallMs).toBe(500); // Single call = wall equals total
  });

  it("should include wall time in summary output", async () => {
    pipelineLog.addStageTime("embed", 300);
    await new Promise(resolve => setTimeout(resolve, 20));
    pipelineLog.addStageTime("embed", 300);

    const ctx: LogContext = { component: "TestPipeline" };
    pipelineLog.summary(ctx, { test: true });

    // New format has "wall" column header and "wall%" column
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("wall%")
    );
  });

  it("should format durations in human-readable format", () => {
    // 2 minutes 30 seconds
    pipelineLog.addStageTime("git", 150000);
    // 45 seconds
    pipelineLog.addStageTime("embed", 45000);
    // 1.5 seconds
    pipelineLog.addStageTime("scan", 1500);

    const ctx: LogContext = { component: "TestPipeline" };
    pipelineLog.summary(ctx, { test: true });

    // Check for human-readable format like "2m 30s" or "45.0s" or "1.5s"
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("2m 30s")
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("45.0s")
    );
  });

  it("should include stage profiling in summary output", () => {
    pipelineLog.addStageTime("scan", 100);
    pipelineLog.addStageTime("parse", 300);
    pipelineLog.addStageTime("embed", 600);

    const ctx: LogContext = { component: "TestPipeline" };
    pipelineLog.summary(ctx, { test: true });

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("STAGE PROFILING:")
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("scan")
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("embed")
    );
    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("TOTAL")
    );
  });

  it("should not include stage profiling in summary when no stages recorded", () => {
    pipelineLog.resetProfiler();
    const ctx: LogContext = { component: "TestPipeline" };
    pipelineLog.summary(ctx, { test: true });

    // Find the last call with SUMMARY
    const summaryCall = (fs.appendFileSync as any).mock.calls.find(
      (call: any[]) => typeof call[1] === "string" && call[1].includes("SUMMARY for TestPipeline")
    );
    expect(summaryCall).toBeDefined();
    expect(summaryCall[1]).not.toContain("STAGE PROFILING:");
  });

  it("should track enrichGit stage with addStageTime", () => {
    pipelineLog.addStageTime("enrichGit", 200);
    pipelineLog.addStageTime("enrichGit", 300);

    const summary = pipelineLog.getStageSummary();

    expect(summary.enrichGit).toBeDefined();
    expect(summary.enrichGit.totalMs).toBe(500);
    expect(summary.enrichGit.count).toBe(2);
  });

  it("should include enrichGit stage in summary output", () => {
    pipelineLog.addStageTime("embed", 1000);
    pipelineLog.addStageTime("enrichGit", 500);

    const ctx: LogContext = { component: "TestPipeline" };
    pipelineLog.summary(ctx, { test: true });

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("enrichGit")
    );
  });

  it("should log enrichmentPhase messages", () => {
    pipelineLog.enrichmentPhase("START", { files: 10, totalChunks: 50 });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PHASE: START")
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("GitEnrich")
    );
  });

  it("should track gitBlame stage with addStageTime", () => {
    pipelineLog.addStageTime("gitBlame", 1000);
    pipelineLog.addStageTime("gitBlame", 2000);

    const summary = pipelineLog.getStageSummary();
    expect(summary.gitBlame).toBeDefined();
    expect(summary.gitBlame.totalMs).toBe(3000);
    expect(summary.gitBlame.count).toBe(2);
  });

  it("should include gitBlame stage in summary output", () => {
    pipelineLog.addStageTime("embed", 1000);
    pipelineLog.addStageTime("gitBlame", 2000);

    const ctx: LogContext = { component: "ChunkPipeline" };
    pipelineLog.summary(ctx, { uptimeMs: 5000 });

    expect(fs.appendFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("gitBlame")
    );
  });

  it("should log enrichmentPhase PREFETCH_START and PREFETCH_COMPLETE", () => {
    pipelineLog.enrichmentPhase("PREFETCH_START", { concurrency: 2 });
    pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", { prefetched: 10, failed: 0, durationMs: 5000 });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PREFETCH_START")
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PREFETCH_COMPLETE")
    );
  });

  it("should log enrichmentPhase COMPLETE with data", () => {
    pipelineLog.enrichmentPhase("COMPLETE", {
      enrichedFiles: 10,
      enrichedChunks: 50,
      failedFiles: 0,
      durationMs: 1234,
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("PHASE: COMPLETE")
    );
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
