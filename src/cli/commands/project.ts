import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { CommandModule } from "yargs";

import { resolveRegistryEnvCodeDefaults } from "../../bootstrap/config/index.js";
import {
  collectionHoldsCodegraphData,
  CollectionRegistry,
  resolveBaseIndexEntry,
  resolveDomainEnvCodeDefaults,
  type CollectionEntry,
} from "../../core/api/index.js";
import { runProjectIndexed, type ProjectIndexedArgs } from "./project-indexed.js";

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export interface ProjectExistArgs {
  path?: string;
  name?: string;
  printName?: boolean;
  json?: boolean;
  /**
   * Match `path` by repository, the server's path-only rule (bd
   * tea-rags-mcp-4nqf5): a subdirectory or a linked worktree answers with the
   * registered entry of the same git repository. Default: exact path match.
   */
  repository?: boolean;
}

/**
 * The entry a path-only read of `path` is served from. A path the server would
 * reject (missing, ambiguous between several projects, an unindexed
 * submodule) matches nothing.
 */
function findRepositoryEntry(registry: CollectionRegistry, path: string): CollectionEntry | null {
  try {
    return resolveBaseIndexEntry(registry, path);
  } catch {
    return null;
  }
}

/** The user's project registry (`TEA_RAGS_DATA_DIR`, default `~/.tea-rags`). */
export function createCollectionRegistry(): CollectionRegistry {
  return new CollectionRegistry(resolveDataDir(), {
    envCodeDefaults: () => resolveRegistryEnvCodeDefaults(resolveDomainEnvCodeDefaults()),
    codegraphDataProbe: collectionHoldsCodegraphData,
  });
}

/**
 * The registered alias `project`, else the alias `project exist --path <path>
 * --repository` answers with (`path` defaults to the cwd). Null when nothing
 * registered matches.
 */
export function resolveProjectAlias(input: { path?: string; project?: string }): string | null {
  const registry = createCollectionRegistry();
  const entry = input.project
    ? registry.findByName(input.project)
    : findRepositoryEntry(registry, resolve(input.path ?? process.cwd()));
  return entry?.name ?? null;
}

export function runProjectExist(args: ProjectExistArgs): void {
  const registry = createCollectionRegistry();
  const lookupByPath = (path: string): CollectionEntry | null =>
    args.repository ? findRepositoryEntry(registry, path) : registry.findByPath(path);
  const entry = args.path ? lookupByPath(resolve(args.path)) : registry.findByName(args.name ?? "");
  const exists = entry !== null;
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ exists, name: entry?.name ?? null })}\n`);
  } else if (args.printName && entry) {
    process.stdout.write(`${entry.name ?? ""}\n`);
  }
  process.exit(exists ? 0 : 1);
}

const existCommand: CommandModule<object, ProjectExistArgs> = {
  command: "exist",
  describe: "Check whether a path or name is a registered tea-rags project (exit 0 = yes, 1 = no)",
  builder: (y) =>
    y
      .option("path", { type: "string", describe: "Project path to check" })
      .option("name", { type: "string", describe: "Project alias to check" })
      .option("print-name", {
        type: "boolean",
        default: false,
        describe: "Print the alias on match",
      })
      .option("repository", {
        type: "boolean",
        default: false,
        describe: "Match --path by git repository (subdirectories and linked worktrees included)",
      })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Emit {exists,name} as JSON",
      })
      .check((a) => {
        if (!a.path && !a.name) throw new Error("Provide --path or --name");
        return true;
      }),
  handler: (argv) => {
    runProjectExist({
      path: argv.path,
      name: argv.name,
      printName: argv.printName,
      json: argv.json,
      repository: argv.repository,
    });
  },
};

/**
 * Registered for help and completion only: `src/cli/index.ts` dispatches
 * `project indexed` to `runProjectIndexedArgv` before yargs loads.
 */
const indexedCommand: CommandModule<object, Omit<ProjectIndexedArgs, "paths"> & { path?: string[] }> = {
  command: "indexed",
  describe:
    "Check whether a file is in the index snapshot serving its working tree (exit 0 = indexed, 1 = not, 2 = usage)",
  builder: (y) =>
    y
      .option("path", { type: "string", array: true, describe: "File to check (repeatable)" })
      .option("command", {
        type: "string",
        describe: "Shell command whose cat/sed/head/tail/less/more operands to check",
      })
      .option("cwd", { type: "string", describe: "Directory --command's relative operands resolve against" })
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Emit {indexed,project,collectionName,relativePath} as JSON",
      })
      .check((a) => {
        if (!a.path?.length && a.command === undefined) throw new Error("Provide --path or --command");
        return true;
      }),
  handler: async (argv) => {
    process.exitCode = await runProjectIndexed({
      paths: argv.path ?? [],
      command: argv.command,
      cwd: argv.cwd,
      json: argv.json,
    });
  },
};

export const projectCommand: CommandModule = {
  command: "project",
  describe: "Query a single registered project (exist, indexed)",
  builder: (y) => y.command(existCommand).command(indexedCommand).demandCommand(1),
  handler: () => {},
};
