#!/usr/bin/env node
import { createConfiguredServer } from "./bootstrap/factory.js";
import { prepareMcpServerRuntime } from "./bootstrap/server-runtime.js";
import { startHttpServer } from "./bootstrap/transport/http.js";
import { startStdioServer } from "./bootstrap/transport/stdio.js";

async function main() {
  const { config, ctx, promptsConfig, deprecations } = await prepareMcpServerRuntime();

  // Graceful shutdown: disconnect embedding provider (daemon refcount--)
  const { cleanup } = ctx;
  if (cleanup) {
    const release = (): void => {
      void cleanup();
    };
    process.on("SIGTERM", release);
    process.on("SIGINT", release);
    process.on("beforeExit", release);
  }

  if (config.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    // bd tea-rags-mcp-e6cpu — stdin closing (or SIGTERM/SIGINT) releases
    // resources and then exits; the listeners above only release.
    await startStdioServer(server, { cleanup: ctx.cleanup });

    // Send deprecation warnings via MCP logging (visible to client)
    if (deprecations.length > 0) {
      const lines = deprecations.map((d) => `${d.oldName} -> use ${d.newName}`).join(", ");
      await server.sendLoggingMessage({ level: "warning", data: `Deprecated env vars: ${lines}` });
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
