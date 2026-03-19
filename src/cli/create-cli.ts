import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { serverCommand } from "./commands/server.js";

/**
 * Create a yargs CLI instance.
 * @param argv - Command line arguments. Pass `undefined` to use process.argv.
 */
export function createCli(argv?: string[]): ReturnType<typeof yargs> {
  return yargs(argv ?? hideBin(process.argv))
    .scriptName("tea-rags")
    .command(serverCommand)
    .demandCommand(1, "Please specify a command. Run with --help to see available commands.")
    .strict()
    .help();
}
