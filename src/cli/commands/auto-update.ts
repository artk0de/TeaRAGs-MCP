/**
 * `tea-rags auto-update <enable|disable|status|run>` — CLI surface of the
 * auto-update watcher (hpg2, spec §6).
 *
 * `run` doubles as the detached updater entry: the spawner redirects the
 * child's stdio to the per-project log fd, so plain stdout writes land in
 * `<dataDir>/logs/auto-update-<project>.log` with no extra plumbing.
 *
 * Same DI shape as `commands/update.ts`: a pure handler over injected deps so
 * tests use object literals; `defaultDeps()` wires the real registry, and the
 * heavyweight App context is built lazily inside `executeUpdater` only for
 * the `run` action.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { autoUpdateLogPath } from "../../bootstrap/auto-update/updater-log.js";
import {
  detectDefaultBranch,
  IndexFreshnessCheck as FreshnessCheckImpl,
  CollectionRegistry as RegistryImpl,
  replayRegistryEnv,
  type CollectionEntry,
  type CollectionRegistry,
  type IndexFreshnessCheck,
} from "../../core/api/public/index.js";
import { runUpdater } from "../auto-update/run-updater.js";

export type AutoUpdateCliAction = "enable" | "disable" | "status" | "run";

export interface AutoUpdateCliArgs {
  project: string;
  branch?: string;
}

export interface AutoUpdateCliDeps {
  registry: Pick<CollectionRegistry, "findByName" | "get" | "setAutoUpdate">;
  freshness: Pick<IndexFreshnessCheck, "check">;
  detectBranch: (repoPath: string) => string;
  logPathFor: (label: string) => string;
  /** Builds the App context and runs the updater; returns its exit code. */
  executeUpdater: (collectionName: string) => Promise<number>;
  out: (line: string) => void;
  errOut: (line: string) => void;
  exit: (code: number) => void;
}

/** Alias first (human input), collectionName second (spawner input). */
function resolveEntry(deps: AutoUpdateCliDeps, project: string): CollectionEntry | null {
  return deps.registry.findByName(project) ?? deps.registry.get(project);
}

export async function runAutoUpdateCliCommand(
  action: AutoUpdateCliAction,
  argv: AutoUpdateCliArgs,
  deps: AutoUpdateCliDeps,
): Promise<void> {
  const entry = resolveEntry(deps, argv.project);
  if (entry === null) {
    deps.errOut(`Project '${argv.project}' is not registered. Run: tea-rags projects`);
    deps.exit(1);
    return;
  }
  const label = entry.name ?? entry.collectionName;

  switch (action) {
    case "enable": {
      const targetBranch = argv.branch ?? deps.detectBranch(entry.path);
      const lastRun = entry.autoUpdate?.lastRun;
      deps.registry.setAutoUpdate(entry.collectionName, {
        enabled: true,
        targetBranch,
        ...(lastRun !== undefined ? { lastRun } : {}),
      });
      deps.out(`auto-update enabled for ${label} (branch: ${targetBranch})`);
      deps.exit(0);
      return;
    }
    case "disable": {
      if (entry.autoUpdate === undefined) {
        deps.out(`auto-update is not configured for ${label} — nothing to disable`);
        deps.exit(0);
        return;
      }
      deps.registry.setAutoUpdate(entry.collectionName, { ...entry.autoUpdate, enabled: false });
      deps.out(`auto-update disabled for ${label} (target branch kept: ${entry.autoUpdate.targetBranch})`);
      deps.exit(0);
      return;
    }
    case "status": {
      const config = entry.autoUpdate;
      deps.out(
        config === undefined
          ? `auto-update: not configured — enable with: tea-rags auto-update enable --project ${label}`
          : `auto-update: ${config.enabled ? `enabled (${config.targetBranch})` : `disabled (target kept: ${config.targetBranch})`}`,
      );
      deps.out(`verdict: ${deps.freshness.check(entry).kind}`);
      const run = config?.lastRun;
      if (run !== undefined) {
        deps.out(
          `last run: ${run.outcome} at ${run.at} — ${run.filesChanged} files in ${run.durationMs}ms${
            run.error !== undefined ? ` (${run.error})` : ""
          }`,
        );
      }
      deps.out(`log: ${deps.logPathFor(label)}`);
      deps.exit(0);
      return;
    }
    case "run": {
      deps.exit(await deps.executeUpdater(entry.collectionName));
    }
  }
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

function defaultDeps(): AutoUpdateCliDeps {
  const dataDir = resolveDataDir();
  const registry = new RegistryImpl(dataDir);
  return {
    registry,
    freshness: new FreshnessCheckImpl(),
    detectBranch: (repoPath) => detectDefaultBranch(repoPath),
    logPathFor: (label) => autoUpdateLogPath(dataDir, label),
    executeUpdater: async (collectionName) => {
      // Registry-first env replay (mirrors prime/tune): the detached process
      // runs in whatever shell env spawned it — the entry's env snapshot must
      // seed unset embedding/qdrant knobs BEFORE the config is parsed.
      const entry = registry.get(collectionName);
      replayRegistryEnv(entry?.env ?? entry?.tuning, process.env);
      const { parseAppConfig } = await import("../../bootstrap/config/index.js");
      const { createAppContext } = await import("../../bootstrap/factory.js");
      const { migrateHomeDir } = await import("../../bootstrap/migrate.js");
      migrateHomeDir();
      const ctx = await createAppContext(parseAppConfig());
      try {
        return await runUpdater(collectionName, {
          app: ctx.app,
          registry,
          freshness: new FreshnessCheckImpl(),
          clock: () => Date.now(),
          log: (line) => process.stdout.write(`${line}\n`),
        });
      } finally {
        ctx.cleanup?.();
      }
    },
    out: (line) => process.stdout.write(`${line}\n`),
    errOut: (line) => process.stderr.write(`${line}\n`),
    exit: (code) => process.exit(code),
  };
}

interface AutoUpdateArgv {
  action: string;
  project: string;
  branch?: string;
}

export const autoUpdateCommand: CommandModule<object, AutoUpdateArgv> = {
  command: "auto-update <action>",
  describe: "Keep a project's index fresh on its target branch (enable/disable/status/run).",
  builder: (y) =>
    y
      .positional("action", {
        describe: "enable | disable | status | run",
        type: "string",
        choices: ["enable", "disable", "status", "run"] as const,
        demandOption: true,
      })
      .option("project", {
        type: "string",
        describe: "Registered project alias (or collection name)",
        demandOption: true,
      })
      .option("branch", {
        type: "string",
        describe: "Target branch for enable (default: autodetected default branch)",
      }) as never,
  handler: async (argv) => {
    await runAutoUpdateCliCommand(
      argv.action as AutoUpdateCliAction,
      { project: argv.project, ...(argv.branch !== undefined ? { branch: argv.branch } : {}) },
      defaultDeps(),
    );
  },
};
