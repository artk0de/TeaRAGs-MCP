#!/usr/bin/env node
import { parseAppConfig } from "./bootstrap/config.js";
import { createAppContext, createConfiguredServer, loadPrompts } from "./bootstrap/factory.js";
import { checkOllamaAvailability } from "./bootstrap/ollama.js";
import { startHttpServer } from "./bootstrap/transport/http.js";
import { startStdioServer } from "./bootstrap/transport/stdio.js";

async function main() {
  const config = parseAppConfig();
  await checkOllamaAvailability(config.embeddingProvider);

  const ctx = createAppContext(config);
  const promptsConfig = loadPrompts(config);

  if (config.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    await startStdioServer(server);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
