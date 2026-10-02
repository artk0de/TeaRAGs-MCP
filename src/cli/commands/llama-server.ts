/**
 * `tea-rags llama-server <subcommand>` — operator helpers for the llama-server
 * embedding provider.
 *
 * `fetch-model` downloads a model's GGUF weights from the Ollama registry into
 * the local data dir, sha256-verified, for a local llama-server (the fallback
 * tier). Work runs over injected deps so tests use object literals.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { downloadVerifiedGguf, resolveOllamaRegistryGguf } from "../../core/api/public/index.js";

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

/** `tea-rags llama-server <fetch-model>` — helpers for the llama-server provider. */
export const llamaServerCommand: CommandModule = {
  command: "llama-server",
  describe: "Helpers for the llama-server embedding provider (fetch-model)",
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
      .demandCommand(1)
      .strict(),
  handler: () => {
    // never reached — yargs delegates to subcommands
  },
};
