/**
 * `tea-rags llama-server <subcommand>` — operator helpers for the llama-server
 * embedding provider.
 *
 * `fetch-model` downloads a model's GGUF weights into the local data dir,
 * sha256-verified, for a local llama-server: a catalog Hugging Face id from its
 * pinned repo, any other reference from the Ollama registry. `choose-model`
 * maps a project's language shares to a catalog model. `command` prints — never runs — the launch, model-download,
 * firewall, keep-awake and autostart lines for a remote GPU host. Work runs
 * over injected deps so tests use object literals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import {
  downloadEmbeddingModelGguf,
  downloadVerifiedGguf,
  EMBEDDING_MODEL_CATALOG,
  InvalidParameterError,
  readGgufContextLength,
  resolveOllamaRegistryGguf,
  selectEmbeddingModelForLanguages,
  type EmbeddingModelCatalogEntry,
  type OllamaRegistryGgufSource,
} from "../../core/api/public/index.js";
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
  /** Models resolved by Hugging Face id before the Ollama registry; defaults to the shipped catalog. */
  catalog?: readonly EmbeddingModelCatalogEntry[];
}

function dataDirOf(env: NodeJS.ProcessEnv, home: string): string {
  return env.TEA_RAGS_DATA_DIR ?? join(home, ".tea-rags");
}

/** `<TEA_RAGS_DATA_DIR | ~/.tea-rags>/models/gguf`. */
function defaultGgufDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(dataDirOf(env, home), "models", "gguf");
}

/**
 * Resolve, download and verify; the LAST printed line is the GGUF path. A
 * catalog id downloads its pinned Hugging Face GGUF into `<data dir>/models/`;
 * any other reference goes to the Ollama registry.
 */
export async function runLlamaServerFetchModel(
  args: LlamaServerFetchModelArgs,
  deps: LlamaServerFetchModelDeps,
): Promise<void> {
  const reference = args.model ?? deps.env.EMBEDDING_MODEL ?? DEFAULT_GGUF_MODEL_REFERENCE;
  const catalogEntry = (deps.catalog ?? EMBEDDING_MODEL_CATALOG).find((entry) => entry.id === reference);
  if (catalogEntry !== undefined) {
    const { gguf } = catalogEntry;
    if (gguf !== null) {
      deps.out(`fetch-model: ${reference} — ${gguf.repo}, ${Math.round(gguf.bytes / (1024 * 1024))} MiB`);
    }
    const dir = args.dir ?? join(dataDirOf(deps.env, deps.home), "models");
    deps.out(await downloadEmbeddingModelGguf(catalogEntry, dir, { fetch: deps.fetch }));
    return;
  }
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

export interface LlamaServerChooseModelArgs {
  /** JSON object: language → fraction of code LOC. */
  shares: string;
}

function parseLanguageShares(shares: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(shares);
  } catch {
    throw new InvalidParameterError("shares", "--shares must be a JSON object of language → fraction");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidParameterError("shares", "--shares must be a JSON object of language → fraction");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [language, share] of entries) {
    if (typeof share !== "number" || !Number.isFinite(share)) {
      throw new InvalidParameterError("shares", `--shares: "${language}" must map to a number`);
    }
  }
  return Object.fromEntries(entries) as Record<string, number>;
}

/** Print `{ model, rule, window, dimensions }` for the project's language shares — one JSON line. */
export function runLlamaServerChooseModel(
  args: LlamaServerChooseModelArgs,
  deps: { out: (line: string) => void },
): void {
  const { model, rule } = selectEmbeddingModelForLanguages(parseLanguageShares(args.shares));
  deps.out(JSON.stringify({ model: model.id, rule, window: model.window, dimensions: model.dimensions }));
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
  home: string;
  /** `<arch>.context_length` of a GGUF on THIS machine; `undefined` when the file is absent or unreadable. */
  readGgufContextLength: (path: string) => Promise<number | undefined>;
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

/**
 * Where the model's GGUF would sit on THIS machine: the given path (`~/` expanded),
 * or the file `fetch-model` writes for a registry reference.
 */
function localGgufCandidate(
  model: string,
  gguf: OllamaRegistryGgufSource | undefined,
  deps: LlamaServerCommandDeps,
): string {
  if (gguf !== undefined) return join(defaultGgufDir(deps.env, deps.home), gguf.fileName);
  return model.startsWith("~/") ? join(deps.home, model.slice(2)) : model;
}

/** Print the operator sheet. Spawns nothing; I/O = the registry manifest read and a local GGUF header read. */
export async function runLlamaServerCommand(args: LlamaServerCommandArgs, deps: LlamaServerCommandDeps): Promise<void> {
  const localOs = llamaServerOsOf(deps.platform);
  const os = args.os ?? localOs;
  const model = args.model ?? deps.env.EMBEDDING_MODEL ?? DEFAULT_GGUF_MODEL_REFERENCE;
  const gguf = isGgufPath(model) ? undefined : await resolveOllamaRegistryGguf(model, { fetch: deps.fetch });
  const modelContextLength = await deps.readGgufContextLength(localGgufCandidate(model, gguf, deps));
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
    modelContextLength,
  });
  deps.out(formatLlamaServerCommandSheet(sheet).trimEnd());
}

function productionCommandDeps(): LlamaServerCommandDeps {
  return {
    fetch: async (input, init) => fetch(input, init),
    out: (line) => process.stdout.write(`${line}\n`),
    env: process.env,
    platform: process.platform,
    home: homedir(),
    readGgufContextLength,
  };
}

/** `tea-rags llama-server <fetch-model|choose-model|command>` — helpers for the llama-server provider. */
export const llamaServerCommand: CommandModule = {
  command: "llama-server",
  describe: "Helpers for the llama-server embedding provider (fetch-model, choose-model, command)",
  builder: (yargs: Argv) =>
    yargs
      .command(
        "fetch-model [model]",
        "Download a model's GGUF (sha256-verified) — a catalog Hugging Face id first, else the Ollama registry — and print its path",
        (y) =>
          y
            .positional("model", {
              type: "string",
              describe:
                "Catalog Hugging Face id (e.g. nomic-ai/CodeRankEmbed) or Ollama model reference (default: EMBEDDING_MODEL, else the jina default)",
            })
            .option("dir", {
              type: "string",
              describe:
                "Destination directory (default: ~/.tea-rags/models for catalog ids, ~/.tea-rags/models/gguf for Ollama references; honours TEA_RAGS_DATA_DIR)",
            }),
        async (argv) => {
          await runLlamaServerFetchModel({ model: argv.model, dir: argv.dir }, productionFetchModelDeps());
        },
      )
      .command(
        "choose-model",
        "Print the embedding model for a project's language shares as JSON { model, rule, window, dimensions }",
        (y) =>
          y.option("shares", {
            type: "string",
            demandOption: true,
            describe: 'JSON object language → fraction of code LOC, e.g. \'{"ruby":0.06,"typescript":0.94}\'',
          }),
        (argv) => {
          runLlamaServerChooseModel({ shares: argv.shares }, { out: (line) => process.stdout.write(`${line}\n`) });
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
