import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandModule } from "yargs";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TuneArgs {
  path?: string;
  full?: boolean;
}

export const tuneCommand: CommandModule<object, TuneArgs> = {
  command: "tune",
  describe: "Auto-tune performance parameters for your hardware",
  builder: (yargs) =>
    yargs
      .option("path", {
        type: "string",
        describe: "Path to project directory (uses source files as benchmark corpus)",
      })
      .option("full", {
        type: "boolean",
        describe: "Run full calibration (slower, more accurate)",
        default: false,
      }),
  handler: (argv) => {
    const tunePath = join(__dirname, "../../../benchmarks/tune.mjs");
    const args: string[] = [];
    if (argv.path) args.push("--path", argv.path);
    if (argv.full) args.push("--full");

    const child = spawn(process.execPath, [tunePath, ...args], {
      stdio: "inherit",
      env: process.env,
    });

    child.on("exit", (code) => process.exit(code ?? 1));
  },
};
