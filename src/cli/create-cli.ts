import yargs from "yargs";
import { hideBin } from "yargs/helpers";

import { doctorCommand } from "./commands/doctor.js";
import { indexCodebaseCommand } from "./commands/index-codebase.js";
import { primeCommand } from "./commands/prime.js";
import { projectsCommand } from "./commands/projects.js";
import { serverCommand } from "./commands/server.js";
import { tuneCommand } from "./commands/tune.js";
import { updateCommand } from "./commands/update.js";
import { worktreeCommand } from "./commands/worktree.js";
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
    .command(worktreeCommand)
    .command(doctorCommand)
    .command(indexCodebaseCommand)
    .completion(
      "completion",
      "Print the shell completion script (bash/zsh). Eval its output in your rc file.",
      // yargs treats this as a "fallback completion function" only when
      // fn.length > 3 (see yargs/lib/completion.js isFallbackCompletionFunction).
      // With 4 params yargs ignores the return value entirely — results MUST
      // be emitted via either `defaultCompletions()` (yargs builds defaults)
      // or `done(matches)` (our custom list).
      (
        _current: string,
        parsedArgv: { _?: unknown[] } | undefined,
        defaultCompletions: () => void,
        done: (completions: string[]) => void,
      ) => {
        const rawPositionals: unknown[] = parsedArgv?._ ?? [];
        const positionals = rawPositionals.map((v) => String(v));
        const tokens = argvSource;
        const projectMatches = maybeCompleteProjectName(tokens, positionals);
        if (projectMatches !== null) {
          done(projectMatches);
          return;
        }
        // Let yargs emit its built-in completions (subcommands, flags) for any
        // position we don't intercept.
        defaultCompletions();
      },
    )
    .demandCommand(1, "Please specify a command. Run with --help to see available commands.")
    .strict()
    .help();
}
