// src/bootstrap/transport/http.ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Bottleneck from "bottleneck";
import express from "express";

import type { PromptsConfig } from "../../mcp/prompts/index.js";
import type { AppConfig } from "../config.js";
import { createConfiguredServer, pkg, type AppContext } from "../factory.js";

export interface HttpServerDeps {
  config: AppConfig;
  ctx: AppContext;
  promptsConfig: PromptsConfig | null;
}

export async function startHttpServer(deps: HttpServerDeps): Promise<void> {
  const { config, ctx, promptsConfig } = deps;

  // Constants for HTTP server configuration
  const RATE_LIMIT_MAX_REQUESTS = 100;
  const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  const RATE_LIMIT_MAX_CONCURRENT = 10;
  const RATE_LIMITER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const SHUTDOWN_GRACE_PERIOD_MS = 10 * 1000; // 10 seconds

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Configure Express to trust proxy for correct IP detection
  app.set("trust proxy", true);

  // Rate limiter group: max 100 requests per 15 minutes per IP, max 10 concurrent per IP
  const rateLimiterGroup = new Bottleneck.Group({
    reservoir: RATE_LIMIT_MAX_REQUESTS,
    reservoirRefreshAmount: RATE_LIMIT_MAX_REQUESTS,
    reservoirRefreshInterval: RATE_LIMIT_WINDOW_MS,
    maxConcurrent: RATE_LIMIT_MAX_CONCURRENT,
  });

  // Helper function to send JSON-RPC error responses
  const sendErrorResponse = (res: express.Response, code: number, message: string, httpStatus = 500) => {
    if (!res.headersSent) {
      res.status(httpStatus).json({
        jsonrpc: "2.0",
        error: { code, message },
        id: null,
      });
    }
  };

  // Periodic cleanup of inactive rate limiters to prevent memory leaks
  const ipLastAccess = new Map<string, number>();

  const cleanupIntervalId = setInterval(() => {
    const now = Date.now();
    const keysToDelete: string[] = [];

    ipLastAccess.forEach((lastAccess, ip) => {
      if (now - lastAccess > RATE_LIMITER_CLEANUP_INTERVAL_MS) {
        keysToDelete.push(ip);
      }
    });

    keysToDelete.forEach((ip) => {
      void rateLimiterGroup.deleteKey(ip);
      ipLastAccess.delete(ip);
    });

    if (keysToDelete.length > 0) {
      console.error(`Cleaned up ${keysToDelete.length} inactive rate limiters`);
    }
  }, RATE_LIMITER_CLEANUP_INTERVAL_MS);

  // Rate limiting middleware
  const rateLimitMiddleware = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const clientIp = req.ip || req.socket.remoteAddress || "unknown";

    try {
      // Update last access time for this IP
      ipLastAccess.set(clientIp, Date.now());

      // Get or create a limiter for this specific IP
      const limiter = rateLimiterGroup.key(clientIp);
      await limiter.schedule(async () => Promise.resolve());
      next();
    } catch (error) {
      // Differentiate between rate limit errors and unexpected errors
      if (error instanceof Bottleneck.BottleneckError) {
        console.error(`Rate limit exceeded for IP ${clientIp}:`, error.message);
      } else {
        console.error("Unexpected rate limiting error:", error);
      }
      sendErrorResponse(res, -32000, "Too many requests", 429);
    }
  };

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      mode: config.transportMode,
      version: pkg.version,
      embedding_provider: config.embeddingProvider,
    });
  });

  app.post("/mcp", rateLimitMiddleware, async (req, res) => {
    // Create a new server for each request
    const requestServer = createConfiguredServer(ctx, promptsConfig);

    // Create transport with enableJsonResponse
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    // Track cleanup state to prevent double cleanup
    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      await transport.close().catch(() => {});
      await requestServer.close().catch(() => {});
    };

    // Set a timeout for the request to prevent hanging
    const timeoutId = setTimeout(() => {
      sendErrorResponse(res, -32000, "Request timeout", 504);
      cleanup().catch((err) => {
        console.error("Error during timeout cleanup:", err);
      });
    }, config.requestTimeoutMs);

    try {
      // Connect server to transport
      await requestServer.connect(transport);

      // Handle the request
      await transport.handleRequest(req, res, req.body);

      // Clean up AFTER the response finishes
      const cleanupHandler = () => {
        clearTimeout(timeoutId);
        cleanup().catch((err) => {
          console.error("Error during response cleanup:", err);
        });
      };

      res.on("finish", cleanupHandler);
      res.on("close", cleanupHandler);
      res.on("error", (err) => {
        console.error("Response stream error:", err);
        cleanupHandler();
      });
    } catch (error) {
      clearTimeout(timeoutId);
      console.error("Error handling MCP request:", error);
      sendErrorResponse(res, -32603, "Internal server error");
      await cleanup();
    }
  });

  const httpServer = app
    .listen(config.httpPort, () => {
      console.error(`Qdrant MCP server running on http://localhost:${config.httpPort}/mcp`);
    })
    .on("error", (error) => {
      console.error("HTTP server error:", error);
      process.exit(1);
    });

  // Graceful shutdown handling
  let isShuttingDown = false;

  const shutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.error("Shutdown signal received, closing HTTP server gracefully...");

    // Clear the cleanup interval to allow graceful shutdown
    clearInterval(cleanupIntervalId);

    // Force shutdown after grace period
    const forceTimeout = setTimeout(() => {
      console.error("Forcing shutdown after timeout");
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);

    httpServer.close(() => {
      clearTimeout(forceTimeout);
      console.error("HTTP server closed");
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
