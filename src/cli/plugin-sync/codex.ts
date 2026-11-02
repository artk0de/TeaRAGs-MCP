import type { readFile } from "node:fs/promises";
import { join } from "node:path";

import { releaseTag, TEA_RAGS_MARKETPLACE, TEA_RAGS_REPO } from "./release-pin.js";
import {
  emptyPluginSyncReport,
  type HarnessCliRunner,
  type HarnessCliRunResult,
  type HarnessPluginSyncAdapter,
  type PluginSyncReport,
} from "./types.js";

export interface CodexPluginSyncDeps {
  runCodex: HarnessCliRunner;
  /** The tea-rags client version the plugins must match — the marketplace is pinned to `v<clientVersion>`. */
  clientVersion: string;
  /** `$CODEX_HOME`, default `~/.codex` — its `config.toml` is the only place Codex records a marketplace's ref. */
  codexHome: string;
  fs: { readFile: typeof readFile };
}

/** One `marketplaces[]` row of `codex plugin marketplace list --json`. */
interface CodexMarketplaceEntry {
  name?: string;
  marketplaceSource?: { sourceType?: string; source?: string };
}

/** The `[marketplaces.tea-rags]` table of `config.toml`. */
interface CodexMarketplacePin {
  ref?: string;
  sparsePaths: string[];
}

/** Sparse paths the documented Codex install uses — the marketplace manifest and the Codex plugin copies. */
const DEFAULT_SPARSE_PATHS = [".agents", "harness/codex"];
const MARKETPLACE_FAILURE_ID = `${TEA_RAGS_MARKETPLACE} marketplace`;

/**
 * Keeps the installed `*@tea-rags` Codex plugins at the release the tea-rags
 * client was cut from. Codex records a git marketplace's ref only in
 * `config.toml`; when it is not `v<clientVersion>` the marketplace is removed
 * and re-added with `--ref <tag>` (removal keeps the plugins' install entries).
 * Every installed plugin is then re-added — `codex plugin add` re-copies it from
 * the pinned snapshot into Codex's plugin cache, which a marketplace change
 * alone does not touch. A pinned tag never moves, so `marketplace upgrade`
 * cannot pull the plugins past the client.
 */
export class CodexPluginSyncAdapter implements HarnessPluginSyncAdapter {
  readonly harness = "codex" as const;

  constructor(private readonly deps: CodexPluginSyncDeps) {}

  async sync(): Promise<PluginSyncReport> {
    const report = emptyPluginSyncReport();
    const marketplaces = await this.deps.runCodex(["plugin", "marketplace", "list", "--json"]);
    if (marketplaces.missing) return { ...report, skipped: "cli-missing" };

    const entry = (
      parseJson(marketplaces.stdout) as { marketplaces?: CodexMarketplaceEntry[] } | undefined
    )?.marketplaces?.find((m) => m.name === TEA_RAGS_MARKETPLACE);
    if (entry === undefined) return { ...report, skipped: "none-installed" };
    if (entry.marketplaceSource?.sourceType === "local") return { ...report, skipped: "dev-marketplace" };

    const list = await this.deps.runCodex(["plugin", "list", "--json", "--marketplace", TEA_RAGS_MARKETPLACE]);
    const installed = installedPlugins(list.stdout);
    if (installed.length === 0) return { ...report, skipped: "none-installed" };

    const pin = await this.readPin();
    const tag = releaseTag(this.deps.clientVersion);
    if (pin.ref !== tag) await this.repin(entry, pin, tag, report);

    for (const { id, version } of installed) {
      const run = await this.deps.runCodex(["plugin", "add", id, "--json"]);
      const added = parseJson(run.stdout) as { version?: unknown } | undefined;
      if (run.code !== 0 || typeof added?.version !== "string") {
        report.failed.push({ id, reason: runFailure(run) });
      } else if (added.version !== version) {
        report.updated.push({ id, oldVersion: version, newVersion: added.version });
      }
    }
    return report;
  }

  private async repin(
    entry: CodexMarketplaceEntry,
    pin: CodexMarketplacePin,
    tag: string,
    report: PluginSyncReport,
  ): Promise<void> {
    const removal = await this.deps.runCodex(["plugin", "marketplace", "remove", TEA_RAGS_MARKETPLACE, "--json"]);
    if (removal.code !== 0) {
      report.failed.push({ id: MARKETPLACE_FAILURE_ID, reason: runFailure(removal) });
      return;
    }
    const sparsePaths = pin.sparsePaths.length > 0 ? pin.sparsePaths : DEFAULT_SPARSE_PATHS;
    const added = await this.addMarketplace(TEA_RAGS_REPO, tag, sparsePaths);
    if (added.code === 0) {
      report.repinned = { from: pin.ref ?? entry.marketplaceSource?.source ?? "unknown", to: tag };
      return;
    }
    report.failed.push({ id: MARKETPLACE_FAILURE_ID, reason: runFailure(added) });
    const previousSource = entry.marketplaceSource?.source;
    if (previousSource !== undefined) await this.addMarketplace(previousSource, pin.ref, sparsePaths);
  }

  private async addMarketplace(
    source: string,
    ref: string | undefined,
    sparsePaths: string[],
  ): Promise<HarnessCliRunResult> {
    const args = ["plugin", "marketplace", "add", source];
    if (ref !== undefined) args.push("--ref", ref);
    for (const path of sparsePaths) args.push("--sparse", path);
    return this.deps.runCodex([...args, "--json"]);
  }

  private async readPin(): Promise<CodexMarketplacePin> {
    try {
      const toml = await this.deps.fs.readFile(join(this.deps.codexHome, "config.toml"), "utf-8");
      return parseMarketplacePin(String(toml));
    } catch {
      return { sparsePaths: [] };
    }
  }
}

/**
 * Reads `ref` and `sparse_paths` of the `[marketplaces.tea-rags]` table — the
 * two single-line keys `codex plugin marketplace add` writes there.
 */
export function parseMarketplacePin(toml: string): CodexMarketplacePin {
  const pin: CodexMarketplacePin = { sparsePaths: [] };
  let inTable = false;
  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inTable =
        line === `[marketplaces.${TEA_RAGS_MARKETPLACE}]` || line === `[marketplaces."${TEA_RAGS_MARKETPLACE}"]`;
      continue;
    }
    if (!inTable) continue;
    const ref = /^ref\s*=\s*"([^"]*)"/.exec(line);
    if (ref) pin.ref = ref[1];
    const sparse = /^sparse_paths\s*=\s*\[(.*)\]/.exec(line);
    if (sparse) pin.sparsePaths = [...sparse[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  }
  return pin;
}

function installedPlugins(stdout: string): { id: string; version: string }[] {
  const rows =
    (parseJson(stdout) as { installed?: { pluginId?: unknown; version?: unknown; installed?: unknown }[] } | undefined)
      ?.installed ?? [];
  return rows
    .filter((r): r is { pluginId: string; version?: unknown; installed?: unknown } => typeof r.pluginId === "string")
    .filter((r) => r.installed !== false && r.pluginId.endsWith(`@${TEA_RAGS_MARKETPLACE}`))
    .map((r) => ({ id: r.pluginId, version: typeof r.version === "string" ? r.version : "unknown" }));
}

/** Codex `--json` prints one (pretty-printed) JSON document on stdout. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function runFailure(run: HarnessCliRunResult): string {
  const message = (parseJson(run.stdout) as { message?: unknown } | undefined)?.message;
  if (typeof message === "string") return message;
  const stderr = run.stderr?.trim().split("\n")[0];
  if (stderr) return stderr.replace(/^Error:\s*/, "");
  return `codex exited with code ${run.code ?? "unknown"}`;
}
