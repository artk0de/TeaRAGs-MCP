import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import {
  CollectionRegistry,
  PROJECT_NAME_RE,
  ProjectRegistryOps,
  QdrantManager,
  type CollectionEntry,
} from "../../core/api/public/index.js";
import { createColorizer } from "../infra/color.js";
import { formatProjectsTable } from "./projects-format.js";

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
type QdrantSurface = Pick<QdrantManager, "listCollections" | "countPoints"> & {
  /**
   * Optional — older Qdrant servers or partial mocks may omit it.
   * Used to exclude physical collections that back an alias from the orphan list.
   */
  aliases?: Pick<QdrantManager["aliases"], "listAliases">;
};

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

/**
 * `--purge` removes the FULL per-collection footprint, so it needs more of
 * Qdrant than a single delete: the generation listing and the alias resolution
 * that say which physical collections belong to this project.
 */
type PurgeQdrantClient = Pick<QdrantManager, "deleteCollection" | "countPoints" | "listCollections"> & {
  aliases: Pick<QdrantManager["aliases"], "listAliases" | "deleteAlias">;
};

export async function runUnregister(args: UnregisterArgs, qdrant?: PurgeQdrantClient): Promise<void> {
  const { registry, ops } = newOps();
  // Capture the entry before it is removed — the purge addresses its collection.
  const entry = registry.findByName(args.name);
  const out = await ops.unregister({ name: args.name });
  if (!out.removed) {
    process.stdout.write(`'${args.name}' was not registered\n`);
    return;
  }
  const collectionName = entry?.collectionName ?? "(unknown)";
  if (args.purge) {
    await purgeFootprint(
      { name: args.name, collectionName, registry, ...(entry?.path ? { path: entry.path } : {}) },
      qdrant,
    );
    return;
  }
  process.stdout.write(
    `Removed '${args.name}' from registry. Note: Qdrant collection '${collectionName}' is still present. Run 'tea-rags projects unregister --name ${args.name} --purge' to remove it.\n`,
  );
}

/**
 * Tear down every artifact the collection owns and print what went, what
 * stayed, and what failed.
 *
 * The purge used to be a single `deleteCollection(entry.collectionName)`, and
 * that name is the ALIAS — so the versioned `code_<hash>_v1/_v2` collections,
 * the `~/.tea-rags/codegraph/*.duckdb` files, the snapshot directory and
 * `<collection>.stats.json` all survived it and had to be cleared by hand
 * (2026-08-15 and 2026-08-17). The saga now sweeps all of them; the detail
 * lines are printed whether or not something failed, because a half-completed
 * purge is exactly the case where the user needs to know what is left.
 */
async function purgeFootprint(
  target: { name: string; collectionName: string; registry: CollectionRegistry; path?: string },
  qdrant?: PurgeQdrantClient,
): Promise<void> {
  const { name, collectionName, registry } = target;
  const client = qdrant ?? (await defaultQdrant());
  const chunkCount = await safeCount(client, collectionName);
  const { createCollectionFootprintPurger } = await import("../../bootstrap/footprint-purge.js");
  const purger = createCollectionFootprintPurger({
    qdrant: client as QdrantManager,
    registry,
    appDataDir: resolveDataDir(),
  });
  const report = await purger.purge({
    logicalName: collectionName,
    ...(target.path ? { path: target.path } : {}),
  });

  const qdrantFailure = report.failures.find((f) => f.artifact === "qdrant");
  process.stdout.write(
    qdrantFailure
      ? `Removed '${name}' from registry; failed to delete Qdrant collection '${qdrantFailure.target}': ${qdrantFailure.reason}\n`
      : `Removed '${name}' from registry; deleted Qdrant collection '${collectionName}' (${chunkCount} chunks)\n`,
  );

  const detail = (label: string, value: string): void => {
    process.stdout.write(`  ${label.padEnd(10)} ${value}\n`);
  };
  if (report.qdrantCollections.length > 0) detail("qdrant:", report.qdrantCollections.join(", "));
  if (report.codegraphDatabases.length > 0) detail("codegraph:", report.codegraphDatabases.join(", "));
  if (report.clearedStores.length > 0) detail("cleared:", [...report.clearedStores].sort().join(", "));
  for (const note of report.kept) detail("kept:", note);
  for (const failure of report.failures) detail("failed:", `${failure.artifact} ${failure.target} — ${failure.reason}`);
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
  const colorizer = createColorizer();
  process.stdout.write(formatProjectsTable(list, { now: new Date(), colorizer, home: homedir() }));
}

export function runInfo(args: InfoArgs): void {
  const { registry } = newOps();
  const entry: CollectionEntry | null = registry.findByName(args.name);
  if (!entry) {
    process.stderr.write(`'${args.name}' was not registered\n`);
    process.exit(1);
    return;
  }

  // Compute live realpath. Missing on disk → null sentinel rendered as
  // "(missing on disk)" in text mode and omitted from JSON. Audit #13.
  let realpath: string | null;
  try {
    realpath = realpathSync(entry.path);
  } catch {
    realpath = null;
  }
  const realpathDiffers = realpath !== null && realpath !== entry.path;

  if (args.json) {
    const payload: Record<string, unknown> = { ...entry };
    if (realpathDiffers) {
      payload.realpath = realpath;
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`name:                ${entry.name ?? "(no name)"}\n`);
  process.stdout.write(`collectionName:      ${entry.collectionName}\n`);
  process.stdout.write(`path:                ${entry.path}\n`);
  if (realpath === null) {
    process.stdout.write(`realpath:            (missing on disk)\n`);
  } else if (realpathDiffers) {
    process.stdout.write(`realpath:            ${realpath}\n`);
    process.stdout.write(`                     (symlink or moved mount — re-register to refresh)\n`);
  }
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

  // Aliased-to physical collections must NOT appear as orphans — they back a
  // registered (or unregistered) alias and removing them destroys live data.
  // Qdrant's listCollections returns physical names (e.g. `code_8b243ffe_v2`);
  // the registry stores alias names (e.g. `code_8b243ffe`). Subtract the alias
  // targets so the user is never told a live backing collection is "orphaned".
  let aliasedTargets = new Set<string>();
  try {
    const aliases = (await client.aliases?.listAliases()) ?? [];
    aliasedTargets = new Set(aliases.map((a) => a.collectionName));
  } catch {
    // Best-effort fallback — older Qdrant servers without alias support fall
    // back to pre-fix behaviour (all physical names visible).
  }

  const collections = await client.listCollections();
  const orphans = collections.filter((c) => !registered.has(c) && !aliasedTargets.has(c));

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
  const { resolveQdrantUrl } = await import("../../core/api/public/index.js");
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
