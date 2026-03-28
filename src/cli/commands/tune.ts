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
  device?: string;
}

/** Build env vars from shared CLI args */
function buildEnv(argv: TuneArgs): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (argv["qdrant-url"]) env.QDRANT_URL = argv["qdrant-url"];
  if (argv["embedding-url"]) env.EMBEDDING_BASE_URL = argv["embedding-url"];
  if (argv.model) env.EMBEDDING_MODEL = argv.model;
  if (argv.provider) env.EMBEDDING_PROVIDER = argv.provider;
  if (argv.device) env.EMBEDDING_DEVICE = argv.device;
  return env;
}

/** Run a benchmark script with forwarded args and env */
function runScript(script: string, argv: TuneArgs): void {
  const scriptPath = join(__dirname, "../../../benchmarks", script);
  const args: string[] = [];
  if (argv.path) args.push("--path", argv.path);
  if (argv.full) args.push("--full");

  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: buildEnv(argv),
  });

  child.on("exit", (code) => process.exit(code ?? 1));
}

export const tuneCommand: CommandModule<object, TuneArgs> = {
  command: "tune [subcommand]",
  describe: "Auto-tune performance parameters for your hardware",
  builder: (yargs) =>
    yargs
      .positional("subcommand", {
        type: "string",
        describe: "Subcommand: embeddings (embedding-only tune)",
        choices: ["embeddings"],
      })
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
      .option("device", {
        type: "string",
        describe: "ONNX device (default: auto-detect). Examples: cpu, webgpu, cuda, dml, coreml",
      })
      .option("full", {
        type: "boolean",
        describe: "Run full calibration (slower, more accurate)",
        default: false,
      }),
  handler: (argv) => {
    const sub = argv.subcommand as string | undefined;
    if (sub === "embeddings") {
      runScript("benchmark-embeddings.mjs", argv);
    } else {
      runScript("tune.mjs", argv);
    }
  },
};
