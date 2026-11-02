import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { createColorizer, type Colorizer } from "../infra/color.js";
import {
  resolvePackageRoot,
  spawnHarnessCli,
  syncHarnessPlugins,
  type HarnessCliRunner,
  type HarnessPluginSyncReport,
  type PluginHarness,
  type PluginSyncReport,
} from "../plugin-sync/index.js";
import { FileCacheStore } from "../update-check/cache-store.js";
import { UpdateCheckService } from "../update-check/check-service.js";
import { formatForCli } from "../update-check/format.js";
import { NpmRegistryClient } from "../update-check/registry-client.js";
import type { UpdateStatus } from "../update-check/types.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";

type SpawnFn = typeof nodeSpawn;
type ExitFn = (code: number) => void;
type AvailableUpdateStatus = Extract<UpdateStatus, { kind: "available" }>;

export interface RunUpdateDeps {
  service: Pick<UpdateCheckService, "checkForUpdate">;
  spawn: SpawnFn;
  runClaude: HarnessCliRunner;
  runCodex: HarnessCliRunner;
  /** Installed client version — read only when the registry is unreachable and the status carries none. */
  clientVersion: () => string;
  homedir: string;
  codexHome: string;
  packageRoot: string;
  exit: ExitFn;
}

export type UpdateInstallOutcome =
  | { kind: "installed"; version: string }
  | { kind: "not-requested" }
  | { kind: "npm-missing" }
  | { kind: "spawn-failed"; message: string }
  | { kind: "failed"; exitCode: number };

/** Everything one `tea-rags update` run did, for a caller that prints it or logs it. */
export interface UpdateRunReport {
  status: UpdateStatus;
  /** Present when a newer version was available. */
  install?: UpdateInstallOutcome;
  /** Absent only when the npm install failed, or the client version could not be read. */
  plugins?: HarnessPluginSyncReport;
  exitCode: number;
}

export interface PerformUpdateOptions {
  /** false → report an available version without installing it; plugins still sync to the installed client. */
  install: boolean;
  /** Called right before npm starts, so a caller can announce the install npm's own output follows. */
  onInstallStart?: (status: AvailableUpdateStatus) => void;
}

const HARNESS_PRODUCT: Record<PluginHarness, string> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

function defaultDeps(spawn: SpawnFn): RunUpdateDeps {
  const service = new UpdateCheckService(new PackageJsonVersionSource(), new NpmRegistryClient(), new FileCacheStore());
  const home = homedir();
  return {
    service,
    spawn,
    runClaude: spawnHarnessCli(spawn, "claude"),
    runCodex: spawnHarnessCli(spawn, "codex"),
    clientVersion: () => new PackageJsonVersionSource().getCurrent(),
    homedir: home,
    codexHome: process.env.CODEX_HOME ?? join(home, ".codex"),
    packageRoot: resolvePackageRoot(),
    exit: (code) => process.exit(code),
  };
}

function withDefaults(depsOverride: Partial<RunUpdateDeps>): RunUpdateDeps {
  return { ...defaultDeps(depsOverride.spawn ?? nodeSpawn), ...depsOverride };
}

/**
 * Non-printing update run: checks the registry, installs the newer version when
 * asked, then syncs every harness's tea-rags plugins to the installed client's
 * release — after an install, when already up to date, and when the registry is
 * unreachable alike. Only a failed install skips the sync.
 */
export async function performUpdate(
  depsOverride: Partial<RunUpdateDeps>,
  options: PerformUpdateOptions,
): Promise<UpdateRunReport> {
  const deps = withDefaults(depsOverride);
  const status = await deps.service.checkForUpdate({ allowNetwork: true, preferCache: false });

  if (status.kind === "available" && options.install) {
    options.onInstallStart?.(status);
    const install = await runNpmInstall(status, deps);
    if (install.kind !== "installed") return { status, install, exitCode: installExitCode(install) };
    return { status, install, plugins: await syncPlugins(deps, status.latest), exitCode: 0 };
  }

  const install: UpdateInstallOutcome | undefined = status.kind === "available" ? { kind: "not-requested" } : undefined;
  const exitCode = status.kind === "unavailable" ? 1 : 0;
  const version = status.kind === "unavailable" ? readClientVersion(deps) : status.current;
  const plugins = version === undefined ? undefined : await syncPlugins(deps, version);
  return { status, ...(install ? { install } : {}), ...(plugins ? { plugins } : {}), exitCode };
}

/**
 * Pure handler — accepts injected deps so tests can mock the service, the
 * spawn function and the harness CLIs without touching node:child_process,
 * the real registry or the machine's plugin installs.
 */
export async function runUpdateCommand(depsOverride: Partial<RunUpdateDeps> = {}): Promise<void> {
  const exit = depsOverride.exit ?? ((code: number) => process.exit(code));
  const report = await performUpdate(depsOverride, { install: true, onInstallStart: printInstallStart });

  switch (report.status.kind) {
    case "up-to-date":
      process.stdout.write(`${formatForCli(report.status, createColorizer())}\n`);
      break;
    case "unavailable":
      process.stderr.write(`${formatForCli(report.status, stderrColorizer())}\n`);
      break;
    case "available":
      printInstallFailure(report.install);
  }
  if (report.plugins) printHarnessPluginSyncReport(report.plugins);
  exit(report.exitCode);
}

/** Colors for stderr lines — gated on stderr's own TTY, not stdout's. */
function stderrColorizer(): Colorizer {
  return createColorizer({ isTTY: Boolean(process.stderr.isTTY) });
}

function printInstallStart(status: AvailableUpdateStatus): void {
  const c = createColorizer();
  process.stdout.write(`Updating tea-rags ${status.current} → ${c.bold(c.ok(status.latest))}...\n`);
}

function readClientVersion(deps: RunUpdateDeps): string | undefined {
  try {
    return deps.clientVersion();
  } catch {
    return undefined;
  }
}

async function syncPlugins(deps: RunUpdateDeps, clientVersion: string): Promise<HarnessPluginSyncReport> {
  return syncHarnessPlugins({
    clientVersion,
    runClaude: deps.runClaude,
    runCodex: deps.runCodex,
    homedir: deps.homedir,
    codexHome: deps.codexHome,
    packageRoot: deps.packageRoot,
  });
}

async function runNpmInstall(status: AvailableUpdateStatus, deps: RunUpdateDeps): Promise<UpdateInstallOutcome> {
  return new Promise((resolve) => {
    // Force postinstall to run even if user's ~/.npmrc has ignore-scripts=true.
    // tea-rags' postinstall (scripts/postinstall.js) is required for proper setup.
    const child = deps.spawn("npm", ["install", "-g", "tea-rags@latest"], {
      stdio: "inherit",
      env: { ...process.env, npm_config_ignore_scripts: "false" },
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message)) {
        resolve({ kind: "npm-missing" });
        return;
      }
      resolve({ kind: "spawn-failed", message: err.message });
    });

    child.on("exit", (code) => {
      resolve(code === 0 ? { kind: "installed", version: status.latest } : { kind: "failed", exitCode: code ?? 1 });
    });
  });
}

function installExitCode(install: UpdateInstallOutcome): number {
  switch (install.kind) {
    case "npm-missing":
      return 127;
    case "spawn-failed":
      return 1;
    case "failed":
      return install.exitCode;
    case "installed":
    case "not-requested":
      return 0;
  }
}

function printInstallFailure(install: UpdateInstallOutcome | undefined): void {
  if (install?.kind === "npm-missing") {
    process.stderr.write(
      `${stderrColorizer().alert("npm not found in PATH. Install Node.js or update tea-rags manually.")}\n`,
    );
  } else if (install?.kind === "spawn-failed") {
    process.stderr.write(`${stderrColorizer().alert(`Failed to spawn npm: ${install.message}`)}\n`);
  }
}

function printHarnessPluginSyncReport(report: HarnessPluginSyncReport): void {
  for (const { harness, report: harnessReport } of report.harnesses) {
    printPluginSyncReport(harness, harnessReport);
  }
}

function printPluginSyncReport(harness: PluginHarness, report: PluginSyncReport): void {
  const product = HARNESS_PRODUCT[harness];
  // Claude Code is the primary harness, so its absence is worth a line; Codex
  // and Cursor are optional and stay silent when not installed.
  if (report.skipped === "none-installed") return;
  if (report.skipped === "cli-missing") {
    if (harness === "claude") process.stdout.write("claude CLI not found — Claude Code plugins not synced.\n");
    return;
  }
  if (report.skipped === "dev-marketplace") {
    process.stdout.write(`${product}: the tea-rags marketplace is a local checkout — plugins left as they are.\n`);
    return;
  }
  const c = createColorizer();
  if (report.repinned) {
    process.stdout.write(
      `${product}: pinned the tea-rags marketplace to ${report.repinned.to} (was ${report.repinned.from}).\n`,
    );
  }
  for (const { id, reason } of report.failed) {
    process.stderr.write(`${stderrColorizer().alert(`✘ ${id}: ${reason}`)}\n`);
  }
  for (const { id, command, acceptWith } of report.needsConfirmation) {
    process.stdout.write(
      `! ${id} asks to run a marketplace-declared command: ${command}\n  Review it, then: ${acceptWith}\n`,
    );
  }
  for (const { id, oldVersion, newVersion } of report.updated) {
    process.stdout.write(`✓ ${id} ${oldVersion} → ${c.bold(c.ok(newVersion))}\n`);
  }
  if (report.updated.length > 0) {
    process.stdout.write(`Restart ${product} to load the updated plugins.\n`);
  } else if (report.failed.length === 0 && report.needsConfirmation.length === 0) {
    process.stdout.write(`${product} plugins are up to date.\n`);
  }
}

export const updateCommand: CommandModule<object, object> = {
  command: "update",
  describe:
    "Check for a newer tea-rags version, install it via npm and bring the tea-rags plugins of Claude Code, Codex and Cursor to the installed release.",
  handler: async () => {
    await runUpdateCommand();
  },
};
