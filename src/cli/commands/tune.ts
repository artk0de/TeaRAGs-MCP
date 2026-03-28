import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandModule } from "yargs";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface TuneArgs {
  path?: string;
  full?: boolean;
  "qdrant-url"?: string;
  "embedding-url"?: string;
  model?: string;
  provider?: string;
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
      .option("qdrant-url", {
        type: "string",
        describe: "Qdrant URL (default: http://localhost:6333)",
      })
      .option("embedding-url", {
        type: "string",
        describe: "Embedding provider URL (default: http://localhost:11434)",
      })
      .option("model", {
        type: "string",
        describe: "Embedding model name",
      })
      .option("provider", {
        type: "string",
        describe: "Embedding provider: ollama or onnx (default: ollama)",
        choices: ["ollama", "onnx"],
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

    // Forward CLI options as env vars for the benchmark script
    const env = { ...process.env };
    if (argv["qdrant-url"]) env.QDRANT_URL = argv["qdrant-url"];
    if (argv["embedding-url"]) env.EMBEDDING_BASE_URL = argv["embedding-url"];
    if (argv.model) env.EMBEDDING_MODEL = argv.model;
    if (argv.provider) env.EMBEDDING_PROVIDER = argv.provider;

    const child = spawn(process.execPath, [tunePath, ...args], {
      stdio: "inherit",
      env,
    });

    child.on("exit", (code) => process.exit(code ?? 1));
  },
};
