import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";
import { PROJECT_NAME_RE } from "../../core/infra/registry/index.js";
import type { CollectionEntry } from "../../core/infra/registry/types.js";

interface RegisterArgs {
  path: string;
  name: string;
}
interface UnregisterArgs {
  name: string;
}
interface ListArgs {
  json?: boolean;
}
interface InfoArgs {
  name: string;
  json?: boolean;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

function newOps(): { registry: CollectionRegistry; ops: ProjectRegistryOps } {
  const registry = new CollectionRegistry(resolveDataDir());
  return { registry, ops: new ProjectRegistryOps({ registry }) };
}

export async function runRegister(args: RegisterArgs): Promise<void> {
  const { ops } = newOps();
  try {
    const out = await ops.register({ path: args.path, name: args.name });
    process.stdout.write(
      `Registered '${args.name}' -> ${out.collectionName}${out.alreadyIndexed ? " (already indexed)" : ""}\n`,
    );
  } catch (err) {
    process.stderr.write(`projects register failed: ${(err as Error).message}\n`);
    process.exit(1);
  }
}

export async function runUnregister(args: UnregisterArgs): Promise<void> {
  const { ops } = newOps();
  const out = await ops.unregister({ name: args.name });
  process.stdout.write(out.removed ? `Removed '${args.name}'\n` : `'${args.name}' was not registered\n`);
}

export function runList(args: ListArgs): void {
  const { registry } = newOps();
  const list = registry.list();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
    return;
  }
  if (list.length === 0) {
    process.stdout.write("(no projects registered)\n");
    return;
  }
  for (const e of list) {
    process.stdout.write(`${e.name ?? "(no name)"}\t${e.collectionName}\t${e.path}\n`);
  }
}

export function runInfo(args: InfoArgs): void {
  const { registry } = newOps();
  const entry: CollectionEntry | null = registry.findByName(args.name);
  if (!entry) {
    process.stderr.write(`'${args.name}' was not registered\n`);
    process.exit(1);
    return;
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    return;
  }
  process.stdout.write(`name:                ${entry.name ?? "(no name)"}\n`);
  process.stdout.write(`collectionName:      ${entry.collectionName}\n`);
  process.stdout.write(`path:                ${entry.path}\n`);
  process.stdout.write(`qdrantUrl:           ${entry.qdrantUrl || "(none)"}\n`);
  process.stdout.write(`embeddingModel:      ${entry.embeddingModel || "(none)"}\n`);
  process.stdout.write(`embeddingDimensions: ${entry.embeddingDimensions || 0}\n`);
  process.stdout.write(`chunksCount:         ${entry.chunksCount}\n`);
  process.stdout.write(`indexedAt:           ${entry.indexedAt || "(never)"}\n`);
  process.stdout.write(`teaRagsVersion:      ${entry.teaRagsVersion || "(unknown)"}\n`);
}

/**
 * `tea-rags projects [register|list|unregister|info]` — grouped subcommands
 * for project registry management. `list` is the default when no subcommand
 * is given.
 */
export const projectsCommand: CommandModule = {
  command: "projects",
  describe: "Manage registered projects (register | list | unregister | info). Defaults to list.",
  builder: (yargs: Argv) =>
    yargs
      .command<RegisterArgs>(
        "register",
        "Register a project path under an alias name",
        (y) =>
          y
            .option("path", {
              type: "string",
              demandOption: true,
              describe: "Absolute path to the project root",
            })
            .option("name", {
              type: "string",
              demandOption: true,
              describe: `Short name to register (regex ${PROJECT_NAME_RE.source})`,
            }),
        async (argv) => runRegister({ path: argv.path, name: argv.name }),
      )
      .command<UnregisterArgs>(
        "unregister",
        "Remove a registered project by name (does not touch Qdrant)",
        (y) => y.option("name", { type: "string", demandOption: true, describe: "Project name to remove" }),
        async (argv) => runUnregister({ name: argv.name }),
      )
      .command<ListArgs>(
        "list",
        "List all registered projects",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => {
          runList({ json: argv.json });
        },
      )
      .command<InfoArgs>(
        "info",
        "Show full info for one registered project",
        (y) =>
          y
            .option("name", { type: "string", demandOption: true, describe: "Project name" })
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => {
          runInfo({ name: argv.name, json: argv.json });
        },
      )
      .command<ListArgs>(
        "$0",
        "List all registered projects (default subcommand)",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => {
          runList({ json: argv.json });
        },
      )
      .demandCommand(0)
      .strict(),
  handler: () => {
    // never reached — yargs delegates to subcommands
  },
};
