import type { CommandModule } from "yargs";

import { runMcpServer } from "../../bootstrap/server-runtime.js";

export interface ServerArgs {
  http?: boolean;
}

/**
 * Run the MCP server. Extracted for testability.
 */
export async function runServer(args: ServerArgs): Promise<void> {
  await runMcpServer({ http: args.http });
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
