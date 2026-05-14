import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { QdrantManager } from "../../core/adapters/qdrant/client.js";
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
  purge?: boolean;
}
interface ListArgs {
  json?: boolean;
}
interface InfoArgs {
  name: string;
  json?: boolean;
}
interface OrphansArgs {
  json?: boolean;
}

/** Narrow surface of QdrantManager that runOrphans needs (allows test injection). */
type QdrantSurface = Pick<QdrantManager, "listCollections" | "countPoints">;

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

export async function runUnregister(
  args: UnregisterArgs,
  qdrant?: Pick<QdrantManager, "deleteCollection" | "countPoints">,
): Promise<void> {
  const { registry, ops } = newOps();
  // Capture the collectionName before the entry is removed so we can purge it.
  const entry = registry.findByName(args.name);
  const out = await ops.unregister({ name: args.name });
  if (!out.removed) {
    process.stdout.write(`'${args.name}' was not registered\n`);
    return;
  }
  const collectionName = entry?.collectionName ?? "(unknown)";
  if (args.purge) {
    const client = qdrant ?? (await defaultQdrant());
    const chunkCount = await safeCount(client, collectionName);
    try {
      await client.deleteCollection(collectionName);
      process.stdout.write(
        `Removed '${args.name}' from registry; deleted Qdrant collection '${collectionName}' (${chunkCount} chunks)\n`,
      );
    } catch (err) {
      process.stdout.write(
        `Removed '${args.name}' from registry; failed to delete Qdrant collection '${collectionName}': ${(err as Error).message}\n`,
      );
    }
    return;
  }
  process.stdout.write(
    `Removed '${args.name}' from registry. Note: Qdrant collection '${collectionName}' is still present. Run 'tea-rags projects unregister --name ${args.name} --purge' to remove it.\n`,
  );
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
 * List Qdrant collections that are not represented in the project registry.
 * Read-only — does not mutate either side. Audit #8 listing half.
 *
 * `qdrant` is an injection point: production code constructs a real
 * QdrantManager via parseAppConfig + resolveQdrantUrl; tests pass a mock.
 */
export async function runOrphans(args: OrphansArgs, qdrant?: QdrantSurface): Promise<void> {
  const { registry } = newOps();
  const client = qdrant ?? (await defaultQdrant());
  const registered = new Set(registry.list().map((e) => e.collectionName));
  const collections = await client.listCollections();
  const orphans = collections.filter((c) => !registered.has(c));

  if (args.json) {
    const rows = await Promise.all(
      orphans.map(async (collectionName) => ({
        collectionName,
        chunksCount: await safeCount(client, collectionName),
      })),
    );
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (orphans.length === 0) {
    process.stdout.write("(no orphan collections)\n");
    return;
  }

  for (const collectionName of orphans) {
    const count = await safeCount(client, collectionName);
    process.stdout.write(`${collectionName}\t${count}\n`);
  }
}

async function safeCount(client: Pick<QdrantManager, "countPoints">, collectionName: string): Promise<number> {
  try {
    return await client.countPoints(collectionName);
  } catch {
    return 0;
  }
}

/**
 * Build a QdrantManager pointed at the same URL the MCP server would use.
 * Resolves via parseAppConfig + resolveQdrantUrl so embedded mode is honored.
 */
async function defaultQdrant(): Promise<QdrantManager> {
  const { parseAppConfig } = await import("../../bootstrap/config/index.js");
  const { resolveQdrantUrl } = await import("../../core/adapters/qdrant/embedded/daemon.js");
  const config = parseAppConfig();
  const resolution = await resolveQdrantUrl(config.qdrantUrl, config.paths.appData);
  return new QdrantManager(resolution.url, config.qdrantApiKey);
}

/**
 * `tea-rags projects [register|list|unregister|info|orphans]` — grouped subcommands
 * for project registry management. `list` is the default when no subcommand
 * is given.
 */
export const projectsCommand: CommandModule = {
  command: "projects",
  describe: "Manage registered projects (register | list | unregister | info | orphans). Defaults to list.",
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
        "Remove a registered project by name (optionally also delete the Qdrant collection)",
        (y) =>
          y.option("name", { type: "string", demandOption: true, describe: "Project name to remove" }).option("purge", {
            type: "boolean",
            default: false,
            describe: "Also delete the underlying Qdrant collection",
          }),
        async (argv) => runUnregister({ name: argv.name, purge: argv.purge }),
      )
      .command<OrphansArgs>(
        "orphans",
        "List Qdrant collections without a registry entry",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        async (argv) => {
          await runOrphans({ json: argv.json });
        },
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
