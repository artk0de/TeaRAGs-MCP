import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandModule } from "yargs";

import { CollectionRegistry, InputValidationError, replayRegistryEnv } from "../../core/api/public/index.js";
import { resolveTuneQdrantUrl } from "../qdrant-url-resolver.js";
import { applyProjectDefaults } from "../registry-resolver.js";
import { mergeTunedEnvIntoRegistry } from "./tune-registry-write.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

interface TuneArgs {
  project?: string;
  path?: string;
  full?: boolean;
  "qdrant-url"?: string;
  "embedding-url"?: string;
  "embedding-fallback-url"?: string;
  model?: string;
  provider?: string;
  device?: string;
}

/** Build env vars from shared CLI args */
function buildEnv(argv: TuneArgs): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (argv["qdrant-url"]) env.QDRANT_URL = argv["qdrant-url"];
  if (argv["embedding-url"]) env.EMBEDDING_BASE_URL = argv["embedding-url"];
  if (argv["embedding-fallback-url"]) env.EMBEDDING_FALLBACK_URL = argv["embedding-fallback-url"];
  if (argv.model) env.EMBEDDING_MODEL = argv.model;
  if (argv.provider) env.EMBEDDING_PROVIDER = argv.provider;
  if (argv.device) env.EMBEDDING_DEVICE = argv.device;
  return env;
}

/** Run a benchmark script with forwarded args and env, releasing the embedded
 *  daemon ref (if any) before exiting. `onSuccess` runs on exit 0, before the
 *  process exits (registry env write for `--project` runs). */
function runScript(script: string, argv: TuneArgs, release?: () => void, onSuccess?: () => void): void {
  const scriptPath = join(__dirname, "../../../benchmarks", script);
  const args: string[] = [];
  if (argv.path) args.push("--path", argv.path);
  if (argv.full) args.push("--full");

  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: "inherit",
    env: buildEnv(argv),
  });

  child.on("exit", (code) => {
    release?.();
    if (code === 0) {
      try {
        onSuccess?.();
      } catch (err) {
        // The tuned run itself succeeded — a registry write failure must not
        // flip the exit code, only surface.
        process.stderr.write(`[tea-rags] tune registry write failed: ${(err as Error).message}\n`);
      }
    }
    process.exit(code ?? 1);
  });
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
      .option("project", {
        type: "string",
        describe: "Resolve --path / --qdrant-url / --embedding-url / --model from registry by project name",
      })
      .option("path", {
        type: "string",
        describe: "Path to project directory (uses source files as benchmark corpus)",
      })
      .option("qdrant-url", {
        type: "string",
        describe:
          "Qdrant URL. If omitted: probes http://localhost:6333, then spawns the embedded daemon (~/.tea-rags/qdrant) and uses its random port.",
      })
      .option("embedding-url", {
        type: "string",
        describe: "Embedding provider URL (default: http://localhost:11434)",
      })
      .option("embedding-fallback-url", {
        type: "string",
        describe: "Embedding fallback URL used when the primary endpoint is unreachable",
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
  handler: async (argv) => {
    let resolved: TuneArgs;
    try {
      resolved = applyProjectDefaults(argv as TuneArgs);
    } catch (err) {
      if (err instanceof InputValidationError) {
        process.stderr.write(`${err.message}\nHint: ${err.hint}\n`);
        process.exit(1);
      }
      throw err;
    }
    // Registry env replay (outer env > registry env > code default): seed the
    // env snapshot the project was indexed with (GIT_ADAPTER et al.) into
    // process.env so the spawned benchmark inherits it via buildEnv. Explicit
    // shell env wins — replayRegistryEnv only fills unset alias groups.
    if (resolved.project) {
      const entry = new CollectionRegistry(resolveDataDir()).findByName(resolved.project);
      replayRegistryEnv(entry?.env ?? entry?.tuning, process.env);
    }
    const resolution = await resolveTuneQdrantUrl(resolved["qdrant-url"]);
    if (resolution.url) {
      resolved["qdrant-url"] = resolution.url;
    }
    const sub = argv.subcommand as string | undefined;
    const script = sub === "embeddings" ? "benchmark-embeddings.mjs" : "tune.mjs";
    // tune → registry env write (9vpnz follow-through): after a successful
    // full-tune run, merge the MEASURED envs (the generated env file) into the
    // project's registry snapshot so the next indexing run picks them up
    // registry-first. Only for `--project` (a bare-path tune has no entry to
    // update) and only for the main tune script (embeddings sub-benchmark
    // writes no env file).
    const writeMeasuredEnv =
      resolved.project && script === "tune.mjs" && resolved.path
        ? (): void => {
            const envFilePath = join(resolved.path as string, "tuned_environment_variables.env");
            if (!existsSync(envFilePath)) return;
            const registry = new CollectionRegistry(resolveDataDir());
            const applied = mergeTunedEnvIntoRegistry(
              registry,
              resolved.project as string,
              readFileSync(envFilePath, "utf-8"),
            );
            if (applied > 0) {
              process.stdout.write(
                `[tea-rags] registry env snapshot updated for '${resolved.project}' (${applied} measured keys)\n`,
              );
            }
          }
        : undefined;
    runScript(script, resolved, resolution.release, writeMeasuredEnv);
  },
};
