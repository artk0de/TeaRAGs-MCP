import type { CommandModule } from "yargs";

import { createConfiguredServer } from "../../bootstrap/factory.js";
import { prepareMcpServerRuntime } from "../../bootstrap/server-runtime.js";
import { startHttpServer } from "../../bootstrap/transport/http.js";
import { startStdioServer } from "../../bootstrap/transport/stdio.js";

export interface ServerArgs {
  http?: boolean;
}

/**
 * Run the MCP server. Extracted for testability.
 */
export async function runServer(args: ServerArgs): Promise<void> {
  const { config, ctx, promptsConfig, deprecations } = await prepareMcpServerRuntime();

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
    // bd tea-rags-mcp-e6cpu — stdin closing (or SIGTERM/SIGINT) releases
    // resources and then exits; the listeners above only release.
    await startStdioServer(server, { cleanup: ctx.cleanup });

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
