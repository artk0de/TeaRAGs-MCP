import type { CommandModule } from "yargs";

export interface ServerArgs {
  http?: boolean;
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
  handler: async (_argv) => {
    // Implementation in xj9d task
    throw new Error("Not implemented yet");
  },
};
