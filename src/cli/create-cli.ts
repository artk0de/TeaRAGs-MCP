import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { primeCommand } from "./commands/prime.js";
import { projectsCommand } from "./commands/projects.js";
import { serverCommand } from "./commands/server.js";
import { tuneCommand } from "./commands/tune.js";
import { updateCommand } from "./commands/update.js";

/**
 * Create a yargs CLI instance.
 * @param argv - Command line arguments. Pass `undefined` to use process.argv.
 */
export function createCli(argv?: string[]): ReturnType<typeof yargs> {
  return yargs(argv ?? hideBin(process.argv))
    .scriptName("tea-rags")
    .command(serverCommand)
    .command(tuneCommand)
    .command(primeCommand)
    .command(updateCommand)
    .command(projectsCommand)
    .demandCommand(1, "Please specify a command. Run with --help to see available commands.")
    .strict()
    .help();
}
