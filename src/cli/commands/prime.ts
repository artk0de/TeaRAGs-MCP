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
    try {
      await runPrime({ path: argv.path, project: argv.project });
    } finally {
      // prime runs as a SessionStart/PreCompact hook; Claude Code waits for the
      // process to exit. A lingering libuv handle (DuckDB pool, undici
      // keep-alive on the Qdrant-cold path) otherwise keeps the process alive
      // and hangs session start until the hook timeout. Honour run-prime's
      // "Always exits 0" contract by forcing termination once the digest is
      // emitted — even if runPrime threw.
      process.exit(0);
    }
  },
};
