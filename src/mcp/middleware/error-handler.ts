/**
 * MCP error handler middleware — catches errors from tool handlers
 * and formats them as MCP-compatible error responses.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { TeaRagsError, UnknownError } from "../../core/infra/errors.js";
import type { McpToolResult } from "../format.js";

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Wraps an MCP tool handler with standardized error handling.
 *
 * - TeaRagsError instances are formatted via `toUserMessage()`.
 * - Unknown errors are wrapped in `UnknownError` first.
 * - All errors are logged to stderr before formatting.
 */
export function errorHandlerMiddleware<T>(
  handler: (args: T, extra: McpExtra) => Promise<McpToolResult>,
): (args: T, extra: McpExtra) => Promise<McpToolResult> {
  return async (args: T, extra: McpExtra): Promise<McpToolResult> => {
    try {
      return await handler(args, extra);
    } catch (e) {
      console.error("[MCP] Tool error:", e);

      if (e instanceof TeaRagsError) {
        return {
          content: [{ type: "text", text: e.toUserMessage() }],
          isError: true,
        };
      }

      const unknown = new UnknownError(e);
      return {
        content: [{ type: "text", text: unknown.toUserMessage() }],
        isError: true,
      };
    }
  };
}

/**
 * Tool config matching McpServer.registerTool's second parameter.
 * Defined locally to avoid issues with extracting types from the generic method.
 */
interface SafeToolConfig<
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  OutputArgs extends ZodRawShapeCompat | AnySchema = ZodRawShapeCompat,
> {
  title?: string;
  description?: string;
  inputSchema?: InputArgs;
  outputSchema?: OutputArgs;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/**
 * Registers an MCP tool with automatic error handling middleware.
 *
 * Drop-in replacement for `server.registerTool(name, config, handler)`.
 * The handler is wrapped with `errorHandlerMiddleware` before registration.
 *
 * McpToolResult is structurally compatible with CallToolResult — both have
 * `content` and optional `isError`. The cast at the SDK boundary is safe.
 */
export function registerToolSafe<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
>(
  server: McpServer,
  name: string,
  config: SafeToolConfig<InputArgs, OutputArgs>,
  handler: ToolCallback<InputArgs>,
): void {
  const wrapped = errorHandlerMiddleware(handler as (...args: [unknown, McpExtra]) => Promise<McpToolResult>);
  server.registerTool(name, config, wrapped as unknown as ToolCallback<InputArgs>);
}
