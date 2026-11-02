/**
 * The detached `tea-rags update --background` run (bd tea-rags-mcp-c2dr6),
 * spawned by prime with stdout/stderr on `<dataDir>/logs/client-update.log`.
 *
 * Every step is logged with its reason, and each guard turns the run into a
 * no-op:
 *  1. dev install (global package dir is an `npm link` symlink) — skipped, stamped
 *  2. live index worker in the worker registry — deferred, NOT stamped, so the
 *     next prime retries
 *  3. canary window — the newest release past its window, or a stamped no-op
 *  4. npm install of that exact version — a failure is stamped for backoff
 *  5. plugin sync to the installed version; a Claude re-pin refused for
 *     project/local-scope installs leaves a hint prime prints
 */

import type { IndexWorkerRecord } from "../index-progress/worker-registry.js";
import type { HarnessPluginSyncReport, PluginSyncReport } from "../plugin-sync/index.js";
import type { NpmReleaseTimeline } from "../update-check/registry-client.js";
import { selectCanaryRelease } from "./canary.js";
import { installExitCode, type UpdateInstallOutcome } from "./npm-install.js";
import type { ClientUpdateStateStore } from "./state-store.js";

export const MANUAL_UPDATE_HINT =
  "automatic update could not re-pin the Claude Code plugins (project/local-scope installs) — run `tea-rags update` by hand";

export interface BackgroundClientUpdateDeps {
  currentVersion: () => string;
  releaseTimeline: () => Promise<NpmReleaseTimeline | null>;
  isDevInstall: () => Promise<boolean>;
  liveWorkers: () => IndexWorkerRecord[];
  /** `npm install -g tea-rags@<version>`. */
  install: (version: string) => Promise<UpdateInstallOutcome>;
  /** Plugin sync to `version`, with the Claude re-pin of scoped installs refused. */
  syncPlugins: (version: string) => Promise<HarnessPluginSyncReport>;
  store: Pick<ClientUpdateStateStore, "read" | "update">;
  clock: () => number;
  out: (line: string) => void;
}

/** Returns the process exit code. Never throws: an unexpected error is a logged, stamped failure. */
export async function runBackgroundClientUpdate(deps: BackgroundClientUpdateDeps): Promise<number> {
  const log = (message: string): void => {
    deps.out(`[client-update ${new Date(deps.clock()).toISOString()}] ${message}`);
  };
  const completed = (): number => {
    deps.store.update({ lastCompletedAt: deps.clock(), lastFailureAt: undefined, consecutiveFailures: 0 });
    return 0;
  };
  const failed = (reason: string, exitCode = 1): number => {
    log(`failed — ${reason}`);
    deps.store.update({ lastFailureAt: deps.clock(), consecutiveFailures: deps.store.read().consecutiveFailures + 1 });
    return exitCode;
  };

  try {
    if (await deps.isDevInstall()) {
      log("skipped — the global tea-rags is an npm link to a checkout (dev install)");
      return completed();
    }

    const live = deps.liveWorkers();
    if (live.length > 0) {
      const pids = live.map((w) => `${w.pid} (${w.projectPath})`).join(", ");
      log(`deferred — index workers still running: ${pids}; the next prime retries`);
      return 0;
    }

    const current = deps.currentVersion();
    const timeline = await deps.releaseTimeline();
    if (timeline === null) return failed("npm registry unreachable");

    const target = selectCanaryRelease(current, timeline, deps.clock());
    if (target === null) {
      log(`no-op — ${current} installed; no newer release has passed its canary window (latest ${timeline.latest})`);
      return completed();
    }

    log(`installing tea-rags ${current} → ${target}`);
    const install = await deps.install(target);
    if (install.kind !== "installed") {
      if (install.kind === "failed" && install.output !== undefined) logInstallOutputTail(install.output, log);
      return failed(`npm install: ${describeInstallFailure(install)}`, Math.max(installExitCode(install), 1));
    }

    const plugins = await deps.syncPlugins(target);
    logPluginSync(plugins, log);
    const deferred = plugins.harnesses.some((h) => h.report.repinDeferred !== undefined);
    deps.store.update({ manualUpdateHint: deferred ? MANUAL_UPDATE_HINT : undefined });
    log(`installed tea-rags ${target} — run /mcp reconnect: the running MCP server still serves ${current}`);
    return completed();
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** npm output tail kept in the log on a failed install — enough for the error, not the ERESOLVE flood. */
const INSTALL_OUTPUT_TAIL_LINES = 20;

function logInstallOutputTail(output: string, log: (message: string) => void): void {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  const tail = lines.slice(-INSTALL_OUTPUT_TAIL_LINES);
  log(`npm output (last ${tail.length} of ${lines.length} lines):`);
  for (const line of tail) log(`  | ${line}`);
}

function describeSkippedHarness(reason: NonNullable<PluginSyncReport["skipped"]>): string {
  switch (reason) {
    case "cli-missing":
      return "harness CLI not on PATH";
    case "none-installed":
      return "no tea-rags plugins installed";
    case "dev-marketplace":
      return "plugins come from a local dev marketplace";
  }
}

function logPluginSync(report: HarnessPluginSyncReport, log: (message: string) => void): void {
  for (const { harness, report: r } of report.harnesses) {
    if (r.skipped !== undefined) {
      log(`${harness}: skipped (${r.skipped}) — ${describeSkippedHarness(r.skipped)}`);
      continue;
    }
    if (r.repinned) log(`${harness}: marketplace pinned to ${r.repinned.to} (was ${r.repinned.from})`);
    if (r.repinDeferred) {
      log(
        `${harness}: re-pin to ${r.repinDeferred.to} refused — it would uninstall ${r.repinDeferred.scopedIds.join(", ")}; run \`tea-rags update\` by hand`,
      );
    }
    for (const { id, oldVersion, newVersion } of r.updated) log(`${harness}: ${id} ${oldVersion} → ${newVersion}`);
    for (const { id, reason } of r.failed) log(`${harness}: ${id} failed — ${reason}`);
    for (const { id, acceptWith } of r.needsConfirmation) log(`${harness}: ${id} needs confirmation — ${acceptWith}`);
  }
}

function describeInstallFailure(install: Exclude<UpdateInstallOutcome, { kind: "installed" }>): string {
  switch (install.kind) {
    case "npm-missing":
      return "npm not found in PATH";
    case "spawn-failed":
      return install.message;
    case "failed":
      return `exit code ${install.exitCode}`;
    case "not-requested":
      return "not requested";
  }
}
