import type { CommandModule } from "yargs";

import { runPrime } from "../prime/run-prime.js";

interface PrimeArgs {
  path?: string;
  project?: string;
}

export const primeCommand: CommandModule<object, PrimeArgs> = {
  command: "prime [path]",
  describe: "Emit a markdown digest of index state for SessionStart context.",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "Project path (typically $CLAUDE_PROJECT_DIR from a hook). Optional if --project is given.",
      })
      .option("project", {
        type: "string",
        describe:
          "Project alias from registry. Resolves --path / --qdrant-url from the registered entry; heuristic discovery only used as fallback.",
      }),
  handler: async (argv) => {
    await runPrime({ path: argv.path, project: argv.project });
  },
};
