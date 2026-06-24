import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { CollectionRegistry } from "../../core/infra/registry/index.js";

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export function runWorktreeList(args: { json: boolean; dataDir?: string }): void {
  const registry = new CollectionRegistry(args.dataDir ?? resolveDataDir());
  const rows = registry.listWorktrees();
  if (args.json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write("No worktree indexes.\n");
    return;
  }
  for (const e of rows) {
    process.stdout.write(
      `${e.worktreeName ?? "(no name)"}\t${e.name ?? e.collectionName}\t<- ${e.worktreeOf}\t${e.chunksCount} chunks\n`,
    );
  }
}

export function runWorktreeInfo(args: { json: boolean; dataDir?: string }): void {
  const registry = new CollectionRegistry(args.dataDir ?? resolveDataDir());
  const entry = registry.findByPath(process.cwd());
  const info =
    !entry || entry.worktreeOf === undefined
      ? { isWorktree: false }
      : {
          isWorktree: true,
          collectionName: entry.collectionName,
          alias: entry.name,
          worktreeOf: entry.worktreeOf,
          worktreeName: entry.worktreeName,
        };
  process.stdout.write(args.json ? `${JSON.stringify(info, null, 2)}\n` : `${JSON.stringify(info)}\n`);
}

async function runWorktreeCreate(argv: {
  name: string;
  from?: string;
  path?: string;
  branch?: string;
  git: boolean;
  json: boolean;
  dataDir?: string;
}): Promise<void> {
  const { parseAppConfig } = await import("../../bootstrap/config/index.js");
  const { createAppContext } = await import("../../bootstrap/factory.js");
  const ctx = await createAppContext(parseAppConfig());
  try {
    const res = await ctx.app.createWorktree({
      name: argv.name,
      from: argv.from,
      path: argv.path,
      createGit: Boolean(argv.git),
      branch: argv.branch,
    });
    // Best-effort diff reindex — warning on failure, NOT fatal (clone already succeeded).
    try {
      await ctx.app.indexCodebase(res.worktreePath, {});
    } catch (e) {
      process.stderr.write(
        `worktree '${argv.name}' created but diff index failed: ${(e as Error).message}\n`,
      );
    }
    if (argv.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Created worktree '${res.alias}' -> ${res.collectionName} at ${res.worktreePath}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(`worktree create failed: ${(err as Error).message}\n`);
    process.exit(1);
  } finally {
    ctx.cleanup?.();
  }
}

async function runWorktreeRemove(argv: {
  name: string;
  force: boolean;
  keepGit: boolean;
  json: boolean;
}): Promise<void> {
  const { parseAppConfig } = await import("../../bootstrap/config/index.js");
  const { createAppContext } = await import("../../bootstrap/factory.js");
  const ctx = await createAppContext(parseAppConfig());
  try {
    const res = await ctx.app.removeWorktree({
      name: argv.name,
      force: Boolean(argv.force),
      keepGit: Boolean(argv.keepGit),
    });
    if (argv.json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else {
      process.stdout.write(res.removed ? `Removed worktree '${argv.name}'.\n` : `'${argv.name}' was not found.\n`);
    }
  } catch (err) {
    process.stderr.write(`worktree remove failed: ${(err as Error).message}\n`);
    process.exit(1);
  } finally {
    ctx.cleanup?.();
  }
}

/**
 * `tea-rags worktree [create|list|remove|info]` — per-worktree index clone management.
 * `list` is the default subcommand.
 */
export const worktreeCommand: CommandModule = {
  command: "worktree",
  describe: "Manage per-worktree index clones (create | list | remove | info). Defaults to list.",
  builder: (yargs: Argv) =>
    yargs
      .command(
        "create <name>",
        "Clone the source index into a worktree collection and diff-reindex",
        (y) =>
          y
            .positional("name", { type: "string", demandOption: true, describe: "Worktree name" })
            .option("from", { type: "string", describe: "Source project alias (default: cwd project)" })
            .option("path", { type: "string", describe: "Worktree path (default: ./<name>)" })
            .option("branch", { type: "string", describe: "Git branch to create in the worktree" })
            .option("git", {
              type: "boolean",
              default: true,
              describe: "Create the git worktree; use --no-git to attach to an existing dir",
            })
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        async (argv) => runWorktreeCreate(argv as never),
      )
      .command(
        "remove <name>",
        "Tear down a worktree index (footprint + registry)",
        (y) =>
          y
            .positional("name", { type: "string", demandOption: true, describe: "Worktree name to remove" })
            .option("force", { type: "boolean", default: false, describe: "Force removal even with uncommitted changes" })
            .option("keep-git", { type: "boolean", default: false, describe: "Keep the git worktree on disk" })
            .option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        async (argv) =>
          runWorktreeRemove({
            name: argv.name as string,
            force: Boolean(argv.force),
            keepGit: Boolean(argv["keep-git"]),
            json: Boolean(argv.json),
          }),
      )
      .command(
        "list",
        "List worktree indexes",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => runWorktreeList({ json: Boolean(argv.json) }),
      )
      .command(
        "info",
        "Show worktree info for the current directory",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => runWorktreeInfo({ json: Boolean(argv.json) }),
      )
      .command(
        "$0",
        "List worktree indexes (default subcommand)",
        (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
        (argv) => runWorktreeList({ json: Boolean(argv.json) }),
      )
      .demandCommand(0)
      .strict(),
  handler: () => {
    // never reached — yargs delegates to subcommands
  },
};
