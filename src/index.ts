#!/usr/bin/env node
import { getZodConfig, parseAppConfig } from "./bootstrap/config/index.js";
import { createAppContext, createConfiguredServer, loadPrompts } from "./bootstrap/factory.js";
import { checkOllamaAvailability } from "./bootstrap/ollama.js";
import { startHttpServer } from "./bootstrap/transport/http.js";
import { startStdioServer } from "./bootstrap/transport/stdio.js";

async function main() {
  const config = parseAppConfig();
  const zodConfig = getZodConfig();
  await checkOllamaAvailability(zodConfig.embedding.provider, zodConfig.embedding.baseUrl, zodConfig.embedding.model);

  const ctx = createAppContext(config);
  const promptsConfig = loadPrompts(config);

  // Log deprecation warnings
  const { deprecations } = zodConfig;
  if (deprecations.length > 0) {
    const lines = deprecations.map((d) => `  ${d.oldName} -> use ${d.newName}`).join("\n");
    console.error(`[tea-rags] Deprecated env vars:\n${lines}`);
  }

  // Graceful shutdown: disconnect embedding provider (daemon refcount--)
  const cleanup = () => {
    if ("terminate" in ctx.embeddings && typeof ctx.embeddings.terminate === "function") {
      void (ctx.embeddings as { terminate: () => Promise<void> }).terminate();
    }
  };
  process.on("SIGTERM", cleanup);
  process.on("SIGINT", cleanup);
  process.on("beforeExit", cleanup);

  if (config.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    await startStdioServer(server);

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
