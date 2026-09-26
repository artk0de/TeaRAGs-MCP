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
  type StaleProjectEntry,
} from "../../core/api/public/index.js";
import { createColorizer, type Colorizer } from "../infra/color.js";
import { formatOrphansTable, formatProjectInfo, formatProjectsTable } from "./projects-format.js";

interface RegisterArgs {
  path: string;
  name: string;
}
/** Exactly one of `name` / `path` / `collection` — yargs enforces it, and the op re-checks. */
interface UnregisterArgs {
  name?: string;
  path?: string;
  collection?: string;
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
interface PruneArgs {
  json?: boolean;
  purge?: boolean;
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

/** Colors for stderr lines — gated on stderr's own TTY, not stdout's. */
function stderrColorizer(): Colorizer {
  return createColorizer({ isTTY: Boolean(process.stderr.isTTY) });
}

export async function runRegister(args: RegisterArgs): Promise<void> {
  const { ops } = newOps();
  try {
    const out = await ops.register({ path: args.path, name: args.name });
    const c = createColorizer();
    process.stdout.write(
      `${c.ok(`Registered '${args.name}'`)} -> ${out.collectionName}${out.alreadyIndexed ? c.dim(" (already indexed)") : ""}\n`,
    );
  } catch (err) {
    process.stderr.write(`${stderrColorizer().alert(`projects register failed: ${(err as Error).message}`)}\n`);
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
  const address = {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.path !== undefined ? { path: args.path } : {}),
    ...(args.collection !== undefined ? { collection: args.collection } : {}),
  };
  const requested = args.name ?? args.path ?? args.collection ?? "";
  let entry: CollectionEntry | null;
  let removed: boolean;
  let leftover: string | null = null;
  try {
    // Capture the entry before it is removed — the purge addresses its collection.
    entry = ops.findEntry(address);
    ({ removed } = await ops.unregister(address));
    if (!entry && args.purge) leftover = ops.unclaimedCollectionFor(address);
  } catch (err) {
    process.stderr.write(`${stderrColorizer().alert(`projects unregister failed: ${(err as Error).message}`)}\n`);
    process.exit(1);
  }
  const c = createColorizer();
  if (!removed || !entry) {
    // No entry, but `--purge` may still have a footprint to tear down: the one a
    // plain unregister left behind, addressed the way its hint said to.
    if (leftover !== null) {
      const purged = await purgeFootprint(
        { name: requested, collectionName: leftover, registry, ...(args.path ? { path: args.path } : {}) },
        qdrant,
        "leftover",
      );
      if (purged) return;
    }
    process.stdout.write(`${c.warn(`'${requested}' was not registered`)}\n`);
    return;
  }
  const label = unregisterLabel(entry);
  const { collectionName } = entry;
  if (args.purge) {
    await purgeFootprint(
      { name: label, collectionName, registry, ...(entry.path ? { path: entry.path } : {}) },
      qdrant,
      "registered",
    );
    return;
  }
  process.stdout.write(
    `${c.ok(`Removed '${label}' from registry.`)} ${c.warn(`Note: Qdrant collection '${collectionName}' is still present. Run 'tea-rags projects unregister ${leftoverAddressFlag(ops, entry)} --purge' to remove it.`)}\n`,
  );
}

/**
 * How an unregister message names the project. `index-codebase <path>`
 * registers WITHOUT an alias (bd tea-rags-mcp-usbb5), so a nameless entry is
 * named by the directory it was registered at — what the user typed.
 */
function unregisterLabel(entry: CollectionEntry): string {
  return entry.name ?? (entry.path || entry.collectionName);
}

/**
 * The flag that reaches this entry's footprint AFTER the entry is gone — never
 * `--name`, which dies with the entry. Which address survives is the op's call
 * (`ProjectRegistryOps#leftoverAddress`), so the hint and the purge that
 * follows it read the same rule.
 */
function leftoverAddressFlag(ops: ProjectRegistryOps, entry: CollectionEntry): string {
  const address = ops.leftoverAddress(entry);
  return "path" in address ? `--path ${shellQuote(address.path)}` : `--collection ${address.collection}`;
}

/** Quote a path for a copy-pasteable hint only when the shell would split or expand it. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
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
 *
 * `leftover` is the footprint of an entry an earlier plain unregister already
 * removed: the headline says so instead of claiming a registry removal, and
 * when the purge found no generation and failed at nothing it prints nothing
 * and answers false — the caller then says "was not registered", which is the
 * truth when there was nothing to purge.
 */
async function purgeFootprint(
  target: { name: string; collectionName: string; registry: CollectionRegistry; path?: string },
  qdrant: PurgeQdrantClient | undefined,
  kind: "registered" | "leftover",
): Promise<boolean> {
  const { name, collectionName } = target;
  const client = qdrant ?? (await defaultQdrant());
  const chunkCount = await safeCount(client, collectionName);
  const report = await purgeCollectionFootprint(target, client);
  if (
    kind === "leftover" &&
    report.qdrantCollections.length === 0 &&
    report.codegraphDatabases.length === 0 &&
    report.failures.length === 0
  ) {
    return false;
  }

  const qdrantFailure = report.failures.find((f) => f.artifact === "qdrant");
  const c = createColorizer();
  const subject =
    kind === "registered"
      ? `Removed '${name}' from registry`
      : `'${name}' was already unregistered; purged its leftovers`;
  process.stdout.write(
    qdrantFailure
      ? `${c.alert(`${subject}; failed to delete Qdrant collection '${qdrantFailure.target}': ${qdrantFailure.reason}`)}\n`
      : `${c.ok(`${subject}; deleted Qdrant collection '${collectionName}' (${chunkCount} chunks)`)}\n`,
  );

  const detail = (label: string, value: string, paint: (s: string) => string = c.dim): void => {
    process.stdout.write(`  ${paint(label.padEnd(10))} ${value}\n`);
  };
  if (report.qdrantCollections.length > 0) detail("qdrant:", report.qdrantCollections.join(", "));
  if (report.codegraphDatabases.length > 0) detail("codegraph:", report.codegraphDatabases.join(", "));
  if (report.clearedStores.length > 0) detail("cleared:", [...report.clearedStores].sort().join(", "));
  for (const note of report.kept) detail("kept:", note, c.warn);
  for (const failure of report.failures) {
    detail("failed:", `${failure.artifact} ${failure.target} — ${failure.reason}`, c.alert);
  }
  return true;
}

/**
 * The part of the footprint purge report both callers render. Declared here
 * rather than imported so the CLI stays off `domains/maintenance` — the real
 * `CollectionPurgeReport` is structurally wider and assigns straight into it.
 */
interface FootprintPurgeOutcome {
  qdrantCollections: string[];
  codegraphDatabases: string[];
  clearedStores: string[];
  kept: string[];
  failures: { artifact: string; target: string; reason: string }[];
}

/**
 * Run the footprint teardown for one collection and hand back what happened.
 * Prints nothing: `unregister --purge` narrates one project, `prune --purge`
 * narrates a sweep, and the purge itself is the same saga either way.
 */
async function purgeCollectionFootprint(
  target: { collectionName: string; registry: CollectionRegistry; path?: string },
  client: PurgeQdrantClient,
): Promise<FootprintPurgeOutcome> {
  const { createCollectionFootprintPurger } = await import("../../bootstrap/footprint-purge.js");
  const purger = createCollectionFootprintPurger({
    qdrant: client as QdrantManager,
    registry: target.registry,
    appDataDir: resolveDataDir(),
  });
  return purger.purge({
    logicalName: target.collectionName,
    ...(target.path ? { path: target.path } : {}),
  });
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
    process.stderr.write(`${stderrColorizer().alert(`'${args.name}' was not registered`)}\n`);
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

  process.stdout.write(formatProjectInfo(entry, realpath, createColorizer()));
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

  const physicalCollectionNames = await client.listCollections();
  const orphanPhysicalCollectionNames = physicalCollectionNames.filter(
    (physicalCollectionName) => !registered.has(physicalCollectionName) && !aliasedTargets.has(physicalCollectionName),
  );

  const rows = await Promise.all(
    orphanPhysicalCollectionNames.map(async (physicalCollectionName) => ({
      collectionName: physicalCollectionName,
      chunksCount: await safeCount(client, physicalCollectionName),
    })),
  );

  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (rows.length === 0) {
    process.stdout.write("(no orphan collections)\n");
    return;
  }

  process.stdout.write(formatOrphansTable(rows, createColorizer()));
}

/** One stale entry as a line: collection, alias, path, chunks, what happens to it. */
function staleLine(entry: StaleProjectEntry, status: string): string {
  return `${entry.collectionName}\t${entry.name ?? "(no alias)"}\t${entry.path}\t${entry.chunksCount}\t${status}\n`;
}

/**
 * How to deal with a stale entry the sweep will not remove.
 *
 * A worktree clone gets its own route: `worktree remove` additionally drops the
 * git worktree admin entry in the source repo, which `unregister --purge` would
 * leave dangling, and it is the teardown the worktree domain sanctions. The
 * directory is already gone, hence `--force`. Everything else is a plain alias,
 * which `register` re-points the moment it is registered at its new path — the
 * index behind it survives the move, so removing it would be the destructive
 * answer to a recoverable situation.
 */
function keptEntryHint(entry: StaleProjectEntry): string {
  const alias = entry.name ?? entry.collectionName;
  if (entry.worktreeOf !== undefined) {
    return `kept — worktree clone; run 'tea-rags worktree remove ${entry.worktreeName ?? alias} --force'`;
  }
  return `kept — re-register the alias at its new path, or run 'tea-rags projects unregister --name ${alias} --purge'`;
}

/**
 * `tea-rags projects prune` — sweep the registry entries whose project
 * directory is gone (removed worktrees, deleted fixtures). The inverse of
 * `projects orphans`, which lists collections without an entry.
 *
 * DRY RUN by default: it prints what it would do and changes nothing. With
 * `--purge` it tears down the Qdrant/codegraph footprint of each PRUNABLE
 * stale entry FIRST and removes the registry entry only when that succeeded,
 * so a failed purge leaves the entry pointing at what is left and the sweep
 * can be retried. One entry's failure never aborts the others.
 *
 * WHICH entries may go is never decided here — `listStale` stamps `prunable`
 * on each entry and this reads it, so the purge and the removal can never
 * disagree about what the sweep is taking.
 *
 * `qdrant` is an injection point, as in `runOrphans`.
 */
export async function runPrune(args: PruneArgs, qdrant?: PurgeQdrantClient): Promise<void> {
  const { registry, ops } = newOps();
  const stale = ops.listStale();

  if (!args.purge) {
    if (args.json) {
      // A dry run decides nothing, so it claims nothing: `removed` and `kept`
      // stay empty, and each stale entry carries `prunable` — the verdict on
      // what --purge would take.
      process.stdout.write(`${JSON.stringify({ stale, removed: [], kept: [] }, null, 2)}\n`);
      return;
    }
    if (stale.length === 0) {
      process.stdout.write("(no stale registry entries)\n");
      return;
    }
    for (const entry of stale) {
      process.stdout.write(staleLine(entry, entry.prunable ? "would remove" : keptEntryHint(entry)));
    }
    const prunable = stale.filter((entry) => entry.prunable).length;
    if (prunable > 0) {
      const noun = prunable === 1 ? "entry" : "entries";
      const pronoun = prunable === 1 ? "it" : "them";
      process.stdout.write(
        `Dry run — nothing removed. Re-run 'tea-rags projects prune --purge' to remove ${prunable} prunable ${noun} and the Qdrant/codegraph footprint behind ${pronoun}.\n`,
      );
    }
    return;
  }

  if (stale.length === 0) {
    process.stdout.write(
      args.json ? `${JSON.stringify({ stale, removed: [], kept: [] }, null, 2)}\n` : "(no stale registry entries)\n",
    );
    return;
  }

  const removed: StaleProjectEntry[] = [];
  const kept: StaleProjectEntry[] = [];
  let attempted = 0;
  let failed = 0;
  let client = qdrant;
  for (const entry of stale) {
    let reason: string | undefined;
    if (entry.prunable) {
      // Resolved lazily: a sweep with nothing to purge must not spin up Qdrant.
      client ??= await defaultQdrant();
      attempted += 1;
      reason = await purgeOneFootprint(entry, registry, client);
      if (reason !== undefined) failed += 1;
    }
    // One entry at a time, so the decision — and its line — lands while the
    // sweep is still running rather than after the last purge.
    const step = ops.pruneStale({
      stale: [entry],
      ...(reason !== undefined ? { blocked: new Set([entry.collectionName]) } : {}),
    });
    removed.push(...step.removed);
    kept.push(...step.kept);
    if (args.json) continue;
    const status =
      step.removed.length > 0
        ? "removed"
        : reason !== undefined
          ? `kept — purge failed: ${reason}`
          : keptEntryHint(entry);
    process.stdout.write(staleLine(entry, status));
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ stale, removed, kept }, null, 2)}\n`);
    return;
  }
  const failures = failed > 0 ? ` (${failed} purge failed)` : "";
  // Every attempt failing is the Qdrant-is-down shape: without this the command
  // exits 0 having removed nothing, and the per-entry reasons are easy to read
  // as N unrelated problems.
  const allFailed = attempted > 0 && failed === attempted ? " — every purge failed; is Qdrant reachable?" : "";
  process.stdout.write(`Removed ${removed.length} · kept ${kept.length}${failures}${allFailed}\n`);
}

/**
 * Tear down one entry's footprint. Returns the reason it must be kept, or
 * `undefined` when the teardown is complete enough to drop the registry entry.
 *
 * The purger collects its own failures, but a THROW — one unguarded line inside
 * it, or a composition that cannot be built at all — would otherwise abort the
 * whole sweep with entries already purged but still registered and nothing
 * printed. Either way the entry stays as the handle for a retry.
 */
async function purgeOneFootprint(
  entry: StaleProjectEntry,
  registry: CollectionRegistry,
  client: PurgeQdrantClient,
): Promise<string | undefined> {
  try {
    const report = await purgeCollectionFootprint(
      { collectionName: entry.collectionName, registry, ...(entry.path ? { path: entry.path } : {}) },
      client,
    );
    const [failure] = report.failures;
    return failure ? `${failure.artifact} ${failure.target} — ${failure.reason}` : undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
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
 * `tea-rags projects [register|list|unregister|info|orphans|prune]` — grouped
 * subcommands for project registry management. `list` is the default when no
 * subcommand is given.
 */
export const projectsCommand: CommandModule = {
  command: "projects",
  describe: "Manage registered projects (register | list | unregister | info | orphans | prune). Defaults to list.",
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
        "Remove a registered project by name, path or collection (optionally also delete its footprint)",
        (y) =>
          y
            .option("name", { type: "string", describe: "Project name to remove" })
            .option("path", {
              type: "string",
              describe: "Project root it was registered at — reaches entries `index-codebase <path>` left unnamed",
            })
            .option("collection", {
              type: "string",
              describe: "Logical collection name (code_<hash>) — reaches a footprint no path derives",
            })
            .conflicts("name", ["path", "collection"])
            .conflicts("path", "collection")
            .check((argv) => {
              if (!argv.name && !argv.path && !argv.collection) {
                throw new Error("Pass exactly one of --name or --path (or --collection)");
              }
              return true;
            })
            .option("purge", {
              type: "boolean",
              default: false,
              describe:
                "Also delete the Qdrant/codegraph footprint — also works after a plain unregister, by --path or --collection",
            }),
        async (argv) =>
          runUnregister({
            ...(argv.name !== undefined ? { name: argv.name } : {}),
            ...(argv.path !== undefined ? { path: argv.path } : {}),
            ...(argv.collection !== undefined ? { collection: argv.collection } : {}),
            purge: argv.purge,
          }),
      )
      .command<OrphansArgs>(
        "orphans",
        "List Qdrant collections without a registry entry",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        async (argv) => {
          await runOrphans({ json: argv.json });
        },
      )
      .command<PruneArgs>(
        "prune",
        "Sweep registry entries whose project directory is gone (dry run unless --purge)",
        (y) =>
          y
            .option("purge", {
              type: "boolean",
              default: false,
              describe: "Remove the entries and delete the Qdrant/codegraph footprint behind them",
            })
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        async (argv) => {
          await runPrune({ json: argv.json, purge: argv.purge });
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
