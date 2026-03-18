/**
 * Tests for MCP error handler middleware.
 */

import { describe, expect, it, vi } from "vitest";

import type { ErrorCode } from "../../../src/core/contracts/errors.js";
import { TeaRagsError, UnknownError } from "../../../src/core/infra/errors.js";
import type { McpToolResult } from "../../../src/mcp/format.js";
import { errorHandlerMiddleware, registerToolSafe } from "../../../src/mcp/middleware/error-handler.js";

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
