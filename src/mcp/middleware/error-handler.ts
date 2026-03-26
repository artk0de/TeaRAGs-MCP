/**
 * MCP error handler middleware — catches errors from tool handlers
 * and formats them as MCP-compatible error responses.
 *
 * When HealthProbes are provided, infra errors (Ollama/Qdrant unavailable)
 * are enriched with the health status of the OTHER service so agents get
 * full infrastructure context in a single error response.
 */

import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import { TeaRagsError, UnknownError } from "../../core/infra/errors.js";
import type { McpToolResult } from "../format.js";

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Health probe functions injected from bootstrap. */
export interface HealthProbes {
  checkQdrant: () => Promise<boolean>;
  checkEmbedding: () => Promise<boolean>;
  qdrantUrl: string;
  embeddingProvider: string;
  embeddingUrl?: string;
}

const INFRA_ERROR_CODES = new Set(["INFRA_OLLAMA_UNAVAILABLE", "INFRA_QDRANT_UNAVAILABLE"]);

async function enrichWithHealthContext(error: TeaRagsError, probes: HealthProbes): Promise<string> {
  const base = error.toUserMessage();
  if (!INFRA_ERROR_CODES.has(error.code)) return base;

  try {
    const isQdrantError = error.code === "INFRA_QDRANT_UNAVAILABLE";
    // Probe the OTHER service
    const otherHealthy = isQdrantError ? await probes.checkEmbedding() : await probes.checkQdrant();

    const qdrantStatus = isQdrantError ? "unavailable" : otherHealthy ? "available" : "unavailable";
    const embeddingStatus = isQdrantError ? (otherHealthy ? "available" : "unavailable") : "unavailable";
    const embeddingUrl = probes.embeddingUrl ? ` (${probes.embeddingUrl})` : "";

    return (
      `${base}\n\n` +
      `Infrastructure status:\n` +
      `  Qdrant: ${qdrantStatus} (${probes.qdrantUrl})\n` +
      `  Embedding (${probes.embeddingProvider}): ${embeddingStatus}${embeddingUrl}`
    );
  } catch {
    return base;
  }
}

/**
 * Wraps an MCP tool handler with standardized error handling.
 *
 * - TeaRagsError instances are formatted via `toUserMessage()`.
 * - Unknown errors are wrapped in `UnknownError` first.
 * - All errors are logged to stderr before formatting.
 * - When healthProbes provided, infra errors include cross-service health context.
 */
export function errorHandlerMiddleware<T>(
  handler: (args: T, extra: McpExtra) => Promise<McpToolResult>,
  healthProbes?: HealthProbes,
): (args: T, extra: McpExtra) => Promise<McpToolResult> {
  return async (args: T, extra: McpExtra): Promise<McpToolResult> => {
    try {
      return await handler(args, extra);
    } catch (e) {
      console.error("[MCP] Tool error:", e);

      if (e instanceof TeaRagsError) {
        const text = healthProbes ? await enrichWithHealthContext(e, healthProbes) : e.toUserMessage();
        return {
          content: [{ type: "text", text }],
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

/** Signature of the register function returned by createRegisterTool. */
export type RegisterToolFn = ReturnType<typeof createRegisterTool>;

/**
 * Creates a registerToolSafe variant with health probes pre-bound.
 * All tools registered with the returned function get health-aware error handling.
 */
export function createRegisterTool(healthProbes?: HealthProbes) {
  return <
    OutputArgs extends ZodRawShapeCompat | AnySchema,
    InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined,
  >(
    server: McpServer,
    name: string,
    config: SafeToolConfig<InputArgs, OutputArgs>,
    handler: ToolCallback<InputArgs>,
  ): void => {
    const wrapped = errorHandlerMiddleware(
      handler as (...args: [unknown, McpExtra]) => Promise<McpToolResult>,
      healthProbes,
    );
    server.registerTool(name, config, wrapped as unknown as ToolCallback<InputArgs>);
  };
}
