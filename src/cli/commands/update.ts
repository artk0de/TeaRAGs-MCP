import { spawn as nodeSpawn } from "node:child_process";

import type { CommandModule } from "yargs";

import { createColorizer, type Colorizer } from "../infra/color.js";
import { FileCacheStore } from "../update-check/cache-store.js";
import { UpdateCheckService } from "../update-check/check-service.js";
import { formatForCli } from "../update-check/format.js";
import { NpmRegistryClient } from "../update-check/registry-client.js";
import type { UpdateStatus } from "../update-check/types.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";

type SpawnFn = typeof nodeSpawn;
type ExitFn = (code: number) => void;

/** One `claude …` invocation; `missing` = the claude CLI is not on PATH. */
export interface ClaudeRunResult {
  code: number | null;
  stdout: string;
  missing: boolean;
}

export interface RunUpdateDeps {
  service: Pick<UpdateCheckService, "checkForUpdate">;
  spawn: SpawnFn;
  runClaude: (args: string[]) => Promise<ClaudeRunResult>;
  exit: ExitFn;
}

export interface PluginSyncReport {
  updated: { id: string; oldVersion: string; newVersion: string }[];
  failed: { id: string; reason: string }[];
  needsConfirmation: { id: string; command: string; sha256: string }[];
  skipped?: "claude-missing" | "none-installed";
}

const PLUGIN_MARKETPLACE = "tea-rags";

function defaultDeps(spawn: SpawnFn): RunUpdateDeps {
  const service = new UpdateCheckService(new PackageJsonVersionSource(), new NpmRegistryClient(), new FileCacheStore());
  return {
    service,
    spawn,
    runClaude: claudeRunner(spawn),
    exit: (code) => process.exit(code),
  };
}

function claudeRunner(spawn: SpawnFn): RunUpdateDeps["runClaude"] {
  return async (args) =>
    new Promise((resolve) => {
      const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        resolve({ code: null, stdout, missing: err.code === "ENOENT" });
      });
      child.on("close", (code) => {
        resolve({ code, stdout, missing: false });
      });
    });
}

/**
 * Pure handler — accepts injected deps so tests can mock the service and
 * the spawn function without touching node:child_process or the real
 * registry.
 */
export async function runUpdateCommand(depsOverride: Partial<RunUpdateDeps> = {}): Promise<void> {
  const deps = { ...defaultDeps(depsOverride.spawn ?? nodeSpawn), ...depsOverride };
  const status = await deps.service.checkForUpdate({ allowNetwork: true, preferCache: false });

  switch (status.kind) {
    case "up-to-date":
      process.stdout.write(`${formatForCli(status, createColorizer())}\n`);
      deps.exit(0);
      return;
    case "unavailable":
      process.stderr.write(`${formatForCli(status, stderrColorizer())}\n`);
      deps.exit(1);
      return;
    case "available":
      runNpmInstall(status, deps);
  }
}

/** Colors for stderr lines — gated on stderr's own TTY, not stdout's. */
function stderrColorizer(): Colorizer {
  return createColorizer({ isTTY: Boolean(process.stderr.isTTY) });
}

function runNpmInstall(status: Extract<UpdateStatus, { kind: "available" }>, deps: RunUpdateDeps): void {
  const c = createColorizer();
  process.stdout.write(`Updating tea-rags ${status.current} → ${c.bold(c.ok(status.latest))}...\n`);
  // Force postinstall to run even if user's ~/.npmrc has ignore-scripts=true.
  // tea-rags' postinstall (scripts/postinstall.js) is required for proper setup.
  const child = deps.spawn("npm", ["install", "-g", "tea-rags@latest"], {
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_scripts: "false" },
  });

  child.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || /ENOENT|not found/i.test(err.message)) {
      process.stderr.write(
        `${stderrColorizer().alert("npm not found in PATH. Install Node.js or update tea-rags manually.")}\n`,
      );
      deps.exit(127);
      return;
    }
    process.stderr.write(`${stderrColorizer().alert(`Failed to spawn npm: ${err.message}`)}\n`);
    deps.exit(1);
  });

  child.on("exit", (code) => {
    if (code !== 0) {
      deps.exit(code ?? 1);
      return;
    }
    void syncClaudePlugins(deps).then((report) => {
      printPluginSyncReport(report);
      deps.exit(0);
    });
  });
}

/**
 * Brings the installed `*@tea-rags` Claude Code plugins to the marketplace's
 * latest. Never passes `-y`: a marketplace-declared command comes back as
 * `needsConfirmation` for a person to accept.
 */
export async function syncClaudePlugins(deps: Pick<RunUpdateDeps, "runClaude">): Promise<PluginSyncReport> {
  const report: PluginSyncReport = { updated: [], failed: [], needsConfirmation: [] };
  const list = await deps.runClaude(["plugin", "list", "--json"]);
  if (list.missing) return { ...report, skipped: "claude-missing" };

  const ids = installedPluginIds(list.stdout);
  if (ids.length === 0) return { ...report, skipped: "none-installed" };

  const marketplace = await deps.runClaude(["plugin", "marketplace", "update", PLUGIN_MARKETPLACE, "--json"]);
  const refresh = parseResultLine(marketplace.stdout);
  if (marketplace.code !== 0) {
    report.failed.push({ id: `${PLUGIN_MARKETPLACE} marketplace`, reason: failureReason(refresh, marketplace.code) });
  }

  for (const id of ids) {
    const updateRun = await deps.runClaude(["plugin", "update", id, "--json"]);
    const updateResult = parseResultLine(updateRun.stdout);
    const shown = updateResult?.shownCommand as { command?: string; sha256?: string } | undefined;
    if (shown?.sha256) {
      report.needsConfirmation.push({ id, command: shown.command ?? "", sha256: shown.sha256 });
    } else if (updateRun.code !== 0 || updateResult?.outcome !== "ok") {
      report.failed.push({ id, reason: failureReason(updateResult, updateRun.code) });
    } else if (typeof updateResult.newVersion === "string" && updateResult.newVersion !== updateResult.oldVersion) {
      report.updated.push({ id, oldVersion: String(updateResult.oldVersion), newVersion: updateResult.newVersion });
    }
  }
  return report;
}

function installedPluginIds(stdout: string): string[] {
  try {
    const plugins = JSON.parse(stdout) as { id?: unknown }[];
    const ids = plugins.map((p) => p.id).filter((id): id is string => typeof id === "string");
    return [...new Set(ids.filter((id) => id.endsWith(`@${PLUGIN_MARKETPLACE}`)))];
  } catch {
    return [];
  }
}

/** The machine-readable result is the last JSON line `--json` prints on stdout. */
function parseResultLine(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!line) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function failureReason(result: Record<string, unknown> | undefined, code: number | null): string {
  if (typeof result?.message === "string") return result.message;
  if (typeof result?.failureCode === "string") return result.failureCode;
  return `claude exited with code ${code ?? "unknown"}`;
}

function printPluginSyncReport(report: PluginSyncReport): void {
  if (report.skipped === "none-installed") return;
  if (report.skipped === "claude-missing") {
    process.stdout.write("claude CLI not found — Claude Code plugins not synced.\n");
    return;
  }
  const c = createColorizer();
  for (const { id, reason } of report.failed) {
    process.stderr.write(`${stderrColorizer().alert(`✘ ${id}: ${reason}`)}\n`);
  }
  for (const { id, command, sha256 } of report.needsConfirmation) {
    process.stdout.write(
      `! ${id} asks to run a marketplace-declared command: ${command}\n` +
        `  Review it, then: claude plugin update ${id} --accept-command ${sha256}\n`,
    );
  }
  for (const { id, oldVersion, newVersion } of report.updated) {
    process.stdout.write(`✓ ${id} ${oldVersion} → ${c.bold(c.ok(newVersion))}\n`);
  }
  if (report.updated.length > 0) {
    process.stdout.write("Restart Claude Code to load the updated plugins.\n");
  } else if (report.failed.length === 0 && report.needsConfirmation.length === 0) {
    process.stdout.write("Claude Code plugins are up to date.\n");
  }
}

export const updateCommand: CommandModule<object, object> = {
  command: "update",
  describe: "Check for a newer tea-rags version, install it via npm and update the tea-rags Claude Code plugins.",
  handler: async () => {
    await runUpdateCommand();
  },
};
