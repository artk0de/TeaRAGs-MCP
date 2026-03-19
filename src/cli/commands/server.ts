import type { CommandModule } from "yargs";

import { getZodConfig, parseAppConfig } from "../../bootstrap/config/index.js";
import { createAppContext, createConfiguredServer, loadPrompts } from "../../bootstrap/factory.js";
import { migrateHomeDir } from "../../bootstrap/migrate.js";
import { startHttpServer } from "../../bootstrap/transport/http.js";
import { startStdioServer } from "../../bootstrap/transport/stdio.js";

export interface ServerArgs {
  http?: boolean;
}

/**
 * Run the MCP server. Extracted for testability.
 */
export async function runServer(args: ServerArgs): Promise<void> {
  migrateHomeDir();

  const config = parseAppConfig();
  const zodConfig = getZodConfig();
  const ctx = await createAppContext(config);
  const promptsConfig = loadPrompts(config);

  // Log deprecation warnings
  const { deprecations } = zodConfig;
  if (deprecations.length > 0) {
    const lines = deprecations.map((d) => `  ${d.oldName} -> use ${d.newName}`).join("\n");
    console.error(`[tea-rags] Deprecated env vars:\n${lines}`);
  }

  // Graceful shutdown
  if (ctx.cleanup) {
    process.on("SIGTERM", ctx.cleanup);
    process.on("SIGINT", ctx.cleanup);
    process.on("beforeExit", ctx.cleanup);
  }

  if (args.http || config.transportMode === "http") {
    await startHttpServer({ config, ctx, promptsConfig });
  } else {
    const server = createConfiguredServer(ctx, promptsConfig);
    await startStdioServer(server);

    if (deprecations.length > 0) {
      const lines = deprecations.map((d) => `${d.oldName} -> use ${d.newName}`).join(", ");
      await server.sendLoggingMessage({ level: "warning", data: `Deprecated env vars: ${lines}` });
    }
  }
}

export const serverCommand: CommandModule<object, ServerArgs> = {
  command: "server",
  describe: "Start the MCP server",
  builder: (yargs) =>
    yargs.option("http", {
      type: "boolean",
      describe: "Use HTTP transport instead of stdio",
      default: false,
    }),
  handler: async (argv) => {
    await runServer({ http: argv.http });
  },
};
