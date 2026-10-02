/**
 * `tea-rags llama-server <subcommand>` — operator helpers for the llama-server
 * embedding provider.
 *
 * `fetch-model` downloads a model's GGUF weights from the Ollama registry into
 * the local data dir, sha256-verified, for a local llama-server (the fallback
 * tier). `command` prints — never runs — the launch, model-download,
 * firewall, keep-awake and autostart lines for a remote GPU host. Work runs
 * over injected deps so tests use object literals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { downloadVerifiedGguf, resolveOllamaRegistryGguf } from "../../core/api/public/index.js";
import {
  formatLlamaServerCommandSheet,
  renderLlamaServerCommands,
  type LlamaServerTargetOs,
} from "./llama-server-command-format.js";

/** The model tea-rags embeds with when EMBEDDING_MODEL is unset. */
const DEFAULT_GGUF_MODEL_REFERENCE = "unclemusclez/jina-embeddings-v2-base-code:latest";

export interface LlamaServerFetchModelArgs {
  /** Ollama registry reference; defaults to EMBEDDING_MODEL, then jina. */
  model?: string;
  /** Destination directory; defaults to `<data dir>/models/gguf`. */
  dir?: string;
}

export interface LlamaServerFetchModelDeps {
  fetch: typeof fetch;
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  home: string;
}

/** `<TEA_RAGS_DATA_DIR | ~/.tea-rags>/models/gguf`. */
function defaultGgufDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.TEA_RAGS_DATA_DIR ?? join(home, ".tea-rags"), "models", "gguf");
}

/** Resolve, download and verify; the LAST printed line is the GGUF path. */
export async function runLlamaServerFetchModel(
  args: LlamaServerFetchModelArgs,
  deps: LlamaServerFetchModelDeps,
): Promise<void> {
  const reference = args.model ?? deps.env.EMBEDDING_MODEL ?? DEFAULT_GGUF_MODEL_REFERENCE;
  const dir = args.dir ?? defaultGgufDir(deps.env, deps.home);
  const source = await resolveOllamaRegistryGguf(reference, { fetch: deps.fetch });
  deps.out(
    `fetch-model: ${reference} — ${Math.round(source.size / (1024 * 1024))} MiB, sha256 ${source.sha256.slice(0, 12)}`,
  );
  const path = await downloadVerifiedGguf(source, dir, { fetch: deps.fetch });
  deps.out(path);
}

function productionFetchModelDeps(): LlamaServerFetchModelDeps {
  return {
    fetch: async (input, init) => fetch(input, init),
    out: (line) => process.stdout.write(`${line}\n`),
    env: process.env,
    home: homedir(),
  };
}

const LLAMA_SERVER_TARGET_OSES: readonly LlamaServerTargetOs[] = ["windows", "linux", "macos"];

export interface LlamaServerCommandArgs {
  bin: string;
  os?: LlamaServerTargetOs;
  device?: string[];
  host?: string;
  port?: number;
  slots?: number;
  /** A GGUF path on the target host, or an Ollama reference to download there. */
  model?: string;
  advertise?: string;
  apiKey?: string;
  autostart?: boolean;
}

export interface LlamaServerCommandDeps {
  /** Reads the registry manifest only — the GGUF itself is downloaded by the operator on the target host. */
  fetch: typeof fetch;
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

function llamaServerOsOf(platform: NodeJS.Platform): LlamaServerTargetOs {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
}

/** A `.gguf` file, an absolute/relative/home path or a drive path; anything else is an Ollama reference. */
function isGgufPath(model: string): boolean {
  return /\.gguf$/i.test(model) || /^([A-Za-z]:[\\/]|[/~.\\])/.test(model);
}

function defaultRemoteModelPath(os: LlamaServerTargetOs, fileName: string): string {
  return os === "windows" ? `C:\\llama-models\\${fileName}` : `~/llama-models/${fileName}`;
}

/** Print the operator sheet. Spawns nothing; the only I/O is the registry manifest read. */
export async function runLlamaServerCommand(args: LlamaServerCommandArgs, deps: LlamaServerCommandDeps): Promise<void> {
  const localOs = llamaServerOsOf(deps.platform);
  const os = args.os ?? localOs;
  const model = args.model ?? deps.env.EMBEDDING_MODEL ?? DEFAULT_GGUF_MODEL_REFERENCE;
  const gguf = isGgufPath(model) ? undefined : await resolveOllamaRegistryGguf(model, { fetch: deps.fetch });
  const sheet = renderLlamaServerCommands({
    os,
    bin: args.bin,
    devices: args.device ?? [],
    host: args.host ?? "0.0.0.0",
    port: args.port ?? 8081,
    slots: args.slots ?? 4,
    modelPath: gguf === undefined ? model : defaultRemoteModelPath(os, gguf.fileName),
    advertise: args.advertise,
    apiKey: args.apiKey,
    autostart: args.autostart ?? false,
    gguf,
    localOs,
  });
  deps.out(formatLlamaServerCommandSheet(sheet).trimEnd());
}

function productionCommandDeps(): LlamaServerCommandDeps {
  return {
    fetch: async (input, init) => fetch(input, init),
    out: (line) => process.stdout.write(`${line}\n`),
    env: process.env,
    platform: process.platform,
  };
}

/** `tea-rags llama-server <fetch-model|command>` — helpers for the llama-server provider. */
export const llamaServerCommand: CommandModule = {
  command: "llama-server",
  describe: "Helpers for the llama-server embedding provider (fetch-model, command)",
  builder: (yargs: Argv) =>
    yargs
      .command(
        "fetch-model [model]",
        "Download a model's GGUF from the Ollama registry (sha256-verified) and print its path",
        (y) =>
          y
            .positional("model", {
              type: "string",
              describe: "Ollama model reference (default: EMBEDDING_MODEL, else the jina default)",
            })
            .option("dir", {
              type: "string",
              describe: "Destination directory (default: ~/.tea-rags/models/gguf, honours TEA_RAGS_DATA_DIR)",
            }),
        async (argv) => {
          await runLlamaServerFetchModel({ model: argv.model, dir: argv.dir }, productionFetchModelDeps());
        },
      )
      .command(
        "command",
        "Print (never run) the commands that serve embeddings with llama-server on a GPU host — one build per run",
        (y) =>
          y
            .option("bin", {
              type: "string",
              demandOption: true,
              describe: "llama-server binary on the target host (one build per run: ROCm, Vulkan, CUDA, Metal)",
            })
            .option("os", {
              choices: LLAMA_SERVER_TARGET_OSES,
              describe: "Target host OS (default: this machine's)",
            })
            .option("device", {
              type: "string",
              array: true,
              describe: "Device id from `<bin> --list-devices`; repeat for each GPU, one port each",
            })
            .option("host", { type: "string", default: "0.0.0.0", describe: "Bind address" })
            .option("port", { type: "number", default: 8081, describe: "Port of the first device" })
            .option("slots", { type: "number", default: 4, describe: "Parallel slots per server (-np)" })
            .option("model", {
              type: "string",
              describe:
                "GGUF path on the target host, or an Ollama reference to download there (default: EMBEDDING_MODEL, else the jina default)",
            })
            .option("advertise", { type: "string", describe: "Address clients dial (goes into EMBEDDING_BASE_URL)" })
            .option("api-key", { type: "string", describe: "Require this key; printed as EMBEDDING_API_KEY" })
            .option("autostart", {
              type: "boolean",
              default: false,
              describe: "Also print start-at-boot registration",
            }),
        async (argv) => {
          await runLlamaServerCommand(
            {
              bin: argv.bin,
              os: argv.os,
              device: argv.device,
              host: argv.host,
              port: argv.port,
              slots: argv.slots,
              model: argv.model,
              advertise: argv.advertise,
              apiKey: argv.apiKey,
              autostart: argv.autostart,
            },
            productionCommandDeps(),
          );
        },
      )
      .demandCommand(1)
      .strict(),
  handler: () => {
    // never reached — yargs delegates to subcommands
  },
};
