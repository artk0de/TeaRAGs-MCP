import type { CommandModule } from "yargs";

import { openInProcessMcpSession } from "../../bootstrap/transport/in-process-session.js";
import { createPathCollectionResolver } from "../../core/api/index.js";
import { flushed, routeConsoleToStderr } from "../call/stdio.js";
import { primeRegistryRuntime } from "../prime/registry-runtime.js";
import { runPrime } from "../prime/run-prime.js";

interface PrimeArgs {
  path?: string;
  project?: string;
  full?: boolean;
  agent?: boolean;
}

export const primeCommand: CommandModule<object, PrimeArgs> = {
  command: "prime [path]",
  describe: "Emit the project digest (tea-rags://project/<alias>/digest) for SessionStart context.",
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
      })
      .option("full", {
        type: "boolean",
        default: false,
        describe: "Append the metrics resource (signal thresholds, labelMap, resolve breakdown) for humans.",
      })
      .option("agent", {
        type: "boolean",
        default: false,
        describe: "Agent digest for SessionStart hooks: alias + collection, actionable freshness.",
      }),
  handler: async (argv) => {
    // The in-process server logs through console; stdout carries only the digest.
    const restoreConsole = routeConsoleToStderr();
    try {
      // The command is the composition actor (bd tea-rags-mcp-nkstp): it holds
      // the api assembly seam and passes the path→collection capability down;
      // the run-prime leaf holds no barrel edge of its own.
      await runPrime({
        path: argv.path,
        project: argv.project,
        full: argv.full,
        agent: argv.agent,
        createPathCollectionResolver,
        registryRuntime: primeRegistryRuntime(),
        openSession: openInProcessMcpSession,
      });
    } finally {
      restoreConsole();
      await flushed(process.stdout);
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
