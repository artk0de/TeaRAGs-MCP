import { fork } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { CollectionRegistry, type IndexOptions } from "../../core/api/public/index.js";
import { pickRegistryEntry, resolveRegistryEnv } from "../index-progress/registry-env.js";
import { createRenderer } from "../index-progress/renderer.js";
import { superviseIndexing } from "../index-progress/supervisor.js";
import { createColorizer } from "../infra/color.js";
import { applyProjectDefaults } from "../registry-resolver.js";

export interface IndexCodebaseArgs {
  path?: string;
  project?: string;
  "wait-enrichments"?: boolean;
  force?: boolean;
  json?: boolean;
  /** Hidden: marks the forked child as the detached indexing worker. */
  __worker?: boolean;
}

/**
 * Fork the same CLI binary as a detached worker that runs the actual indexing.
 * `detached` + own process group means the worker survives the foreground's exit
 * (default mode detaches once embeddings finish); `ipc` carries progress back.
 * stdio is otherwise ignored — the foreground owns the terminal and renders.
 */
function forkWorker(
  path: string,
  options: IndexOptions,
  envOverrides: Record<string, string>,
): ReturnType<typeof fork> {
  return fork(process.argv[1], ["index-codebase", "--__worker"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    // Registry-resolved config seeds the worker env; ambient process.env wins so
    // explicit overrides still take precedence (gap-fill, not override).
    env: { ...envOverrides, ...process.env, TEA_RAGS_INDEX_WORKER: JSON.stringify({ path, options }) },
  });
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

/**
 * Resolve the registered project alias for the given resolved path.
 * Uses `findByPath` for exact path match, then falls back to `get(collectionName)`
 * when collectionName is known. Returns null when no alias is registered.
 */
function resolveProjectName(registry: CollectionRegistry, resolvedPath: string): string | null {
  const entry = registry.findByPath(resolvedPath);
  return entry?.name ?? null;
}

export const indexCodebaseCommand: CommandModule<object, IndexCodebaseArgs> = {
  command: "index-codebase [path]",
  describe: "Index a codebase with live embedding + per-provider enrichment progress.",
  builder: (yargs) =>
    yargs
      .positional("path", {
        type: "string",
        describe: "Project path to index. Optional if --project is given (defaults to cwd).",
      })
      .option("project", {
        type: "string",
        describe: "Project alias from the registry. Resolves --path from the registered entry.",
      })
      .option("wait-enrichments", {
        type: "boolean",
        default: false,
        describe:
          "Stay until every enrichment provider finishes (full per-provider bars). Default: detach after embeddings with an ETA.",
      })
      .option("force", {
        type: "boolean",
        default: false,
        describe: "Force a full re-index from scratch instead of incremental.",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe:
          "Emit a single JSON object to stdout at finish instead of human-readable output. Intended for agent/script consumers.",
      })
      .option("__worker", { type: "boolean", default: false, hidden: true }),
  handler: async (argv) => {
    // Forked child path: run the worker entry, not another supervisor.
    if (argv.__worker) {
      const { main } = await import("../index-progress/worker.js");
      await main();
      return;
    }

    const resolved = applyProjectDefaults(argv);
    const path = resolve(resolved.path ?? process.cwd());
    const options: IndexOptions = { forceReindex: Boolean(argv.force) };
    const waitEnrichments = Boolean(argv["wait-enrichments"]);
    const jsonMode = Boolean(argv.json);

    // Seed the worker's embedding / codegraph config from the registry (the
    // named project, this path's entry, or — for a new project — the most
    // recently indexed one) so the operator need not re-export EMBEDDING_* envs.
    const dataDir = resolveDataDir();
    const registry = new CollectionRegistry(dataDir);
    const registryEnv = resolveRegistryEnv(pickRegistryEntry(registry, { project: argv.project, path }));

    // Resolve the registered project alias for the status block.
    const projectName = argv.project ?? resolveProjectName(registry, path) ?? undefined;

    // JSON mode forces NO_COLOR semantics so the output is clean for parsing.
    const colors = createColorizer(jsonMode ? { env: { NO_COLOR: "1" }, isTTY: false } : undefined);
    const renderer = createRenderer({ isTTY: Boolean(process.stderr.isTTY), colors, json: jsonMode });
    const child = forkWorker(path, options, registryEnv);

    const code = await superviseIndexing(child, {
      renderer,
      waitEnrichments,
      colors,
      out: (line) => process.stdout.write(`${line}\n`),
      now: () => Date.now(),
      projectName,
      path,
    });

    // Detached + own process group: exiting the foreground here leaves the worker
    // running to finish enrichment in default mode. In --wait mode the worker has
    // already emitted `done`, so exiting is clean.
    process.exit(code);
  },
};
