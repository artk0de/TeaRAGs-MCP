import type { CommandModule } from "yargs";

import { runPrime } from "../prime/run-prime.js";

interface PrimeArgs {
  path: string;
}

export const primeCommand: CommandModule<object, PrimeArgs> = {
  command: "prime <path>",
  describe: "Emit a markdown digest of index state for SessionStart context.",
  builder: (yargs) =>
    yargs.positional("path", {
      type: "string",
      describe: "Project path (typically $CLAUDE_PROJECT_DIR from a hook)",
      demandOption: true,
    }),
  handler: async (argv) => {
    await runPrime(argv.path);
  },
};
