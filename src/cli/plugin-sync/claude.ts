import { releaseTag, TEA_RAGS_GIT_URL, TEA_RAGS_MARKETPLACE } from "./release-pin.js";
import {
  emptyPluginSyncReport,
  type HarnessCliRunner,
  type HarnessCliRunResult,
  type HarnessPluginSyncAdapter,
  type PluginSyncReport,
} from "./types.js";

export interface ClaudePluginSyncDeps {
  runClaude: HarnessCliRunner;
  /** The tea-rags client version the plugins must match — the marketplace is pinned to `v<clientVersion>`. */
  clientVersion: string;
}

interface InstalledClaudePlugin {
  id: string;
  version: string;
  scope: string;
}

/** One row of `claude plugin marketplace list --json`. */
interface ClaudeMarketplaceEntry {
  name: string;
  source?: string;
  url?: string;
  repo?: string;
  ref?: string;
}

/** Marketplace sources that read a directory on disk — a developer checkout serving its own working tree. */
const LOCAL_MARKETPLACE_SOURCES = new Set(["directory", "file"]);
const MARKETPLACE_FAILURE_ID = `${TEA_RAGS_MARKETPLACE} marketplace`;

/**
 * Keeps the installed `*@tea-rags` Claude Code plugins at the release the
 * tea-rags client was cut from: the marketplace is pinned to `v<clientVersion>`
 * (`claude plugin marketplace add <git-url>#<tag>`). Claude Code has no way to
 * move an added marketplace to another ref, so a re-pin is remove + add; the
 * removal uninstalls the marketplace's plugins, which are reinstalled at user
 * scope. A re-added marketplace carries no `autoUpdate`, i.e. background
 * auto-update stays off (the third-party default). Never passes `-y`: a
 * marketplace-declared command comes back as `needsConfirmation`.
 */
export class ClaudePluginSyncAdapter implements HarnessPluginSyncAdapter {
  readonly harness = "claude" as const;

  constructor(private readonly deps: ClaudePluginSyncDeps) {}

  async sync(): Promise<PluginSyncReport> {
    const report = emptyPluginSyncReport();
    const list = await this.deps.runClaude(["plugin", "list", "--json"]);
    if (list.missing) return { ...report, skipped: "cli-missing" };

    const installed = installedPlugins(list.stdout);
    if (installed.length === 0) return { ...report, skipped: "none-installed" };

    const marketplaces = await this.deps.runClaude(["plugin", "marketplace", "list", "--json"]);
    const entry = parseMarketplaces(marketplaces.stdout).find((m) => m.name === TEA_RAGS_MARKETPLACE);
    if (entry?.source !== undefined && LOCAL_MARKETPLACE_SOURCES.has(entry.source)) {
      return { ...report, skipped: "dev-marketplace" };
    }

    const tag = releaseTag(this.deps.clientVersion);
    if (entry?.ref === tag) {
      await this.updateInPlace(installed, report);
    } else {
      await this.repin(entry, tag, installed, report);
    }
    return report;
  }

  private async updateInPlace(installed: InstalledClaudePlugin[], report: PluginSyncReport): Promise<void> {
    for (const { id } of installed) {
      const run = await this.deps.runClaude(["plugin", "update", id, "--json"]);
      const result = parseResultLine(run.stdout);
      if (this.recordConfirmation(id, result, `claude plugin update ${id}`, report)) continue;
      if (run.code !== 0 || result?.outcome !== "ok") {
        report.failed.push({ id, reason: failureReason(result, run.code) });
      } else if (typeof result.newVersion === "string" && result.newVersion !== result.oldVersion) {
        report.updated.push({ id, oldVersion: String(result.oldVersion), newVersion: result.newVersion });
      }
    }
  }

  private async repin(
    entry: ClaudeMarketplaceEntry | undefined,
    tag: string,
    installed: InstalledClaudePlugin[],
    report: PluginSyncReport,
  ): Promise<void> {
    if (entry !== undefined) {
      const removal = await this.deps.runClaude(["plugin", "marketplace", "remove", TEA_RAGS_MARKETPLACE, "--json"]);
      if (removal.code !== 0) {
        report.failed.push({ id: MARKETPLACE_FAILURE_ID, reason: runFailure(removal) });
        return;
      }
    }

    const added = await this.addMarketplace(`${TEA_RAGS_GIT_URL}#${tag}`);
    if (added.code === 0) {
      report.repinned = { from: entry === undefined ? "none" : describeSource(entry), to: tag };
    } else {
      report.failed.push({ id: MARKETPLACE_FAILURE_ID, reason: runFailure(added) });
      const previous = entry === undefined ? undefined : sourceArgument(entry);
      if (previous === undefined || (await this.addMarketplace(previous)).code !== 0) return;
    }

    await this.reinstall(installed, report);
  }

  private async addMarketplace(source: string): Promise<HarnessCliRunResult> {
    return this.deps.runClaude(["plugin", "marketplace", "add", source, "--json"]);
  }

  /** The marketplace removal uninstalled every plugin it served; put the user-scope ones back. */
  private async reinstall(installed: InstalledClaudePlugin[], report: PluginSyncReport): Promise<void> {
    for (const { id, scope } of installed) {
      if (scope !== "user") {
        report.failed.push({
          id,
          reason: `uninstalled with the marketplace re-pin; reinstall it from its project: claude plugin install ${id} --scope ${scope}`,
        });
        continue;
      }
      const run = await this.deps.runClaude(["plugin", "install", id, "--scope", scope, "--json"]);
      const result = parseResultLine(run.stdout);
      if (this.recordConfirmation(id, result, `claude plugin install ${id} --scope ${scope}`, report)) continue;
      if (run.code !== 0 || result?.outcome !== "ok") {
        report.failed.push({ id, reason: failureReason(result, run.code) });
      }
    }

    const after = await this.deps.runClaude(["plugin", "list", "--json"]);
    const versions = new Map(installedPlugins(after.stdout).map((p) => [p.id, p.version]));
    for (const { id, version } of installed) {
      const newVersion = versions.get(id);
      if (newVersion !== undefined && newVersion !== version) {
        report.updated.push({ id, oldVersion: version, newVersion });
      }
    }
  }

  private recordConfirmation(
    id: string,
    result: Record<string, unknown> | undefined,
    rerun: string,
    report: PluginSyncReport,
  ): boolean {
    const shown = result?.shownCommand as { command?: string; sha256?: string } | undefined;
    if (!shown?.sha256) return false;
    report.needsConfirmation.push({
      id,
      command: shown.command ?? "",
      sha256: shown.sha256,
      acceptWith: `${rerun} --accept-command ${shown.sha256}`,
    });
    return true;
  }
}

function installedPlugins(stdout: string): InstalledClaudePlugin[] {
  try {
    const rows = JSON.parse(stdout) as { id?: unknown; version?: unknown; scope?: unknown }[];
    const byId = new Map<string, InstalledClaudePlugin>();
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id.endsWith(`@${TEA_RAGS_MARKETPLACE}`) || byId.has(row.id)) continue;
      byId.set(row.id, {
        id: row.id,
        version: typeof row.version === "string" ? row.version : "unknown",
        scope: typeof row.scope === "string" ? row.scope : "user",
      });
    }
    return [...byId.values()];
  } catch {
    return [];
  }
}

function parseMarketplaces(stdout: string): ClaudeMarketplaceEntry[] {
  try {
    const rows = JSON.parse(stdout) as unknown;
    return Array.isArray(rows) ? (rows as ClaudeMarketplaceEntry[]) : [];
  } catch {
    return [];
  }
}

/** The `marketplace add` argument that recreates `entry`, or undefined for a source it cannot express. */
function sourceArgument(entry: ClaudeMarketplaceEntry): string | undefined {
  const base = entry.url ?? entry.repo;
  if (base === undefined) return undefined;
  return entry.ref === undefined ? base : `${base}#${entry.ref}`;
}

function describeSource(entry: ClaudeMarketplaceEntry): string {
  return entry.ref ?? entry.repo ?? entry.url ?? entry.source ?? "unknown";
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

function runFailure(run: HarnessCliRunResult): string {
  return failureReason(parseResultLine(run.stdout), run.code);
}

function failureReason(result: Record<string, unknown> | undefined, code: number | null): string {
  if (typeof result?.message === "string") return result.message;
  if (typeof result?.failureCode === "string") return result.failureCode;
  return `claude exited with code ${code ?? "unknown"}`;
}
