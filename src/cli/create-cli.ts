import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { primeCommand } from "./commands/prime.js";
import { projectsCommand } from "./commands/projects.js";
import { serverCommand } from "./commands/server.js";
import { tuneCommand } from "./commands/tune.js";
import { updateCommand } from "./commands/update.js";
import { maybeCompleteProjectName } from "./completion.js";

/**
 * Create a yargs CLI instance.
 * @param argv - Command line arguments. Pass `undefined` to use process.argv.
 */
export function createCli(argv?: string[]): ReturnType<typeof yargs> {
  const argvSource = argv ?? hideBin(process.argv);
  return yargs(argvSource)
    .scriptName("tea-rags")
    .command(serverCommand)
    .command(tuneCommand)
    .command(primeCommand)
    .command(updateCommand)
    .command(projectsCommand)
    .completion(
      "completion",
      "Print the shell completion script (bash/zsh). Eval its output in your rc file.",
      (_current, parsedArgv: { _?: unknown[] } | undefined) => {
        const rawPositionals: unknown[] = parsedArgv?._ ?? [];
        const positionals = rawPositionals.map((v) => String(v));
        // process.argv excludes the runtime + script; tokens we care about start
        // after `--get-yargs-completions` (added by the install script).
        const tokens = argvSource;
        const projectMatches = maybeCompleteProjectName(tokens, positionals);
        return projectMatches ?? [];
      },
    )
    .demandCommand(1, "Please specify a command. Run with --help to see available commands.")
    .strict()
    .help();
}
