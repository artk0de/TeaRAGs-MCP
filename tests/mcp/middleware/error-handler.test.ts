/**
 * Tests for MCP error handler middleware.
 */

import { describe, expect, it, vi } from "vitest";

import type { ErrorCode } from "../../../src/core/contracts/errors.js";
import { TeaRagsError, UnknownError } from "../../../src/core/infra/errors.js";
import type { McpToolResult } from "../../../src/mcp/format.js";
import {
  errorHandlerMiddleware,
  registerToolSafe,
  type HealthProbes,
} from "../../../src/mcp/middleware/error-handler.js";

/** Concrete TeaRagsError subclass for testing. */
class TestError extends TeaRagsError {
  constructor(message: string) {
    super({
      code: "TEST_ERROR" as ErrorCode,
      message,
      hint: "This is a test hint",
      httpStatus: 400,
    });
  }
}

describe("errorHandlerMiddleware", () => {
  it("returns handler result unchanged on success", async () => {
    const expected: McpToolResult = {
      content: [{ type: "text", text: "ok" }],
    };
    const handler = vi.fn().mockResolvedValue(expected);

    const wrapped = errorHandlerMiddleware(handler);
    const result = await wrapped({ foo: "bar" }, {} as never);

    expect(result).toBe(expected);
    expect(handler).toHaveBeenCalledWith({ foo: "bar" }, {});
  });

  it("catches TeaRagsError and returns formatted user message", async () => {
    const error = new TestError("something broke");
    const handler = vi.fn().mockRejectedValue(error);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler);
    const result = await wrapped({}, {} as never);

    expect(result).toEqual({
      content: [{ type: "text", text: error.toUserMessage() }],
      isError: true,
    });
    expect(stderrSpy).toHaveBeenCalledWith("[MCP] Tool error:", error);

    stderrSpy.mockRestore();
  });

  it("wraps unknown Error in UnknownError and returns formatted message", async () => {
    const error = new Error("raw failure");
    const handler = vi.fn().mockRejectedValue(error);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler);
    const result = await wrapped({}, {} as never);

    const unknown = new UnknownError(error);
    expect(result).toEqual({
      content: [{ type: "text", text: unknown.toUserMessage() }],
      isError: true,
    });
    expect(stderrSpy).toHaveBeenCalledWith("[MCP] Tool error:", error);

    stderrSpy.mockRestore();
  });

  it("wraps non-Error thrown values in UnknownError", async () => {
    const handler = vi.fn().mockRejectedValue("string error");

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler);
    const result = await wrapped({}, {} as never);

    const unknown = new UnknownError("string error");
    expect(result).toEqual({
      content: [{ type: "text", text: unknown.toUserMessage() }],
      isError: true,
    });

    stderrSpy.mockRestore();
  });
});

/** Concrete infra error for testing health-aware enrichment. */
class InfraOllamaError extends TeaRagsError {
  constructor() {
    super({
      code: "INFRA_OLLAMA_UNAVAILABLE" as ErrorCode,
      message: "Ollama is not reachable at http://primary:11434",
      hint: "Start Ollama",
      httpStatus: 503,
    });
  }
}

class InfraQdrantError extends TeaRagsError {
  constructor() {
    super({
      code: "INFRA_QDRANT_UNAVAILABLE" as ErrorCode,
      message: "Qdrant is not reachable at http://localhost:6333",
      hint: "Start Qdrant",
      httpStatus: 503,
    });
  }
}

function makeProbes(overrides?: Partial<HealthProbes>): HealthProbes {
  return {
    checkQdrant: vi.fn().mockResolvedValue(true),
    checkEmbedding: vi.fn().mockResolvedValue(true),
    qdrantUrl: "http://localhost:6333",
    embeddingProvider: "ollama",
    embeddingUrl: "http://primary:11434",
    ...overrides,
  };
}

describe("health-aware error enrichment", () => {
  it("appends Qdrant health context to OllamaUnavailableError", async () => {
    const probes = makeProbes();
    const handler = vi.fn().mockRejectedValue(new InfraOllamaError());
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler, probes);
    const result = await wrapped({}, {} as never);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Infrastructure status:");
    expect(text).toContain("Qdrant: available");
    expect(text).toContain("Embedding (ollama): unavailable");
    expect(result.isError).toBe(true);

    stderrSpy.mockRestore();
  });

  it("appends embedding health context to QdrantUnavailableError", async () => {
    const probes = makeProbes();
    const handler = vi.fn().mockRejectedValue(new InfraQdrantError());
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler, probes);
    const result = await wrapped({}, {} as never);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toContain("Infrastructure status:");
    expect(text).toContain("Qdrant: unavailable");
    expect(text).toContain("Embedding (ollama): available");

    stderrSpy.mockRestore();
  });

  it("falls back to base message when health probe throws", async () => {
    const probes = makeProbes({ checkEmbedding: vi.fn().mockRejectedValue(new Error("probe crash")) });
    const error = new InfraQdrantError();
    const handler = vi.fn().mockRejectedValue(error);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler, probes);
    const result = await wrapped({}, {} as never);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    // Should still return base message without crash
    expect(text).toContain("INFRA_QDRANT_UNAVAILABLE");
    expect(text).not.toContain("Infrastructure status:");

    stderrSpy.mockRestore();
  });

  it("does not enrich non-infra errors", async () => {
    const probes = makeProbes();
    const error = new TestError("regular error");
    const handler = vi.fn().mockRejectedValue(error);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler, probes);
    const result = await wrapped({}, {} as never);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).not.toContain("Infrastructure status:");
    expect(text).toBe(error.toUserMessage());

    stderrSpy.mockRestore();
  });

  it("works without health probes (backward compat)", async () => {
    const error = new InfraOllamaError();
    const handler = vi.fn().mockRejectedValue(error);
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const wrapped = errorHandlerMiddleware(handler);
    const result = await wrapped({}, {} as never);

    const text = result.content[0].type === "text" ? result.content[0].text : "";
    expect(text).toBe(error.toUserMessage());
    expect(text).not.toContain("Infrastructure status:");

    stderrSpy.mockRestore();
  });
});

describe("registerToolSafe", () => {
  it("wraps handler with error middleware and registers on server", () => {
    const mockRegisterTool = vi.fn();
    const server = { registerTool: mockRegisterTool } as any;
    const handler = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });

    registerToolSafe(server, "test_tool", { description: "test" } as any, handler);

    expect(mockRegisterTool).toHaveBeenCalledTimes(1);
    expect(mockRegisterTool.mock.calls[0][0]).toBe("test_tool");
    // Handler should be wrapped (not the original)
    expect(mockRegisterTool.mock.calls[0][2]).not.toBe(handler);
  });
});
