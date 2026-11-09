import type { spawn as nodeSpawn } from "node:child_process";
import type * as fsPromises from "node:fs/promises";
import { join } from "node:path";

import { compareSemver, isValidSemver } from "../update-check/semver.js";
import { TEA_RAGS_MARKETPLACE } from "./release-pin.js";
import {
  emptyPluginSyncReport,
  spawnCliCommand,
  type HarnessCliRunner,
  type HarnessPluginSyncAdapter,
  type PluginSyncReport,
} from "./types.js";

export type ZcodePluginFs = Pick<typeof fsPromises, "realpath">;

export interface ZcodePluginSyncDeps {
  runZcode: HarnessCliRunner;
  /** The tea-rags client version the plugins must match — the catalog never updates a plugin past it. */
  clientVersion: string;
  /** Root of the installed tea-rags package — `harness/zcode` is its own release-faithful marketplace. */
  packageRoot: string;
  fs?: ZcodePluginFs;
}

/** One row of `zcode plugins marketplace list --json`. */
interface ZcodeMarketplaceEntry {
  id?: string;
  name?: string;
  source?: { source?: string; path?: string };
}

/** One installed / catalog row of `zcode plugins list [--available] --json`. */
interface ZcodePluginRow {
  id?: string;
  name?: string;
  marketplace?: string;
  version?: string;
}

/** Marketplace sources that read a directory on disk. */
const LOCAL_MARKETPLACE_SOURCES = new Set(["directory", "file"]);
const MARKETPLACE_FAILURE_ID = `${TEA_RAGS_MARKETPLACE} marketplace`;

/**
 * Keeps the installed `*@tea-rags` ZCode plugins at the release the tea-rags
 * client was cut from. ZCode's CLI (`zcode plugins …`) has no marketplace ref
 * pinning, so the release guarantee comes from guards instead of a pin: the
 * marketplace is refreshed, and a plugin is updated only when its catalog
 * version sits strictly between the installed one and the client
 * (`installed < latest <= client`) — never past the client, never a downgrade.
 * The channel the install documents — a directory marketplace on the package's
 * own `harness/zcode` — serves exactly the client's release, so there the
 * guards are tautological. Any other local marketplace is a developer checkout
 * serving its own working tree and is left alone. `plugins update` re-reads a
 * directory marketplace by itself (observed, zcode 0.17.0), but the refresh is
 * explicit anyway so a remote (github) marketplace clone is current before its
 * catalog is trusted.
 */
export class ZcodePluginSyncAdapter implements HarnessPluginSyncAdapter {
  readonly harness = "zcode" as const;

  constructor(private readonly deps: ZcodePluginSyncDeps) {}

  async sync(): Promise<PluginSyncReport> {
    const report = emptyPluginSyncReport();
    const installedList = await this.deps.runZcode(["plugins", "list", "--json"]);
    if (installedList.missing) return { ...report, skipped: "cli-missing" };

    const installed = installedRows(installedList.stdout);
    if (installed.length === 0) return { ...report, skipped: "none-installed" };

    const marketplaces = await this.deps.runZcode(["plugins", "marketplace", "list", "--json"]);
    const entry = (parseJson(marketplaces.stdout) as ZcodeMarketplaceEntry[] | undefined)?.find(
      (m) => (m.name ?? m.id) === TEA_RAGS_MARKETPLACE,
    );
    if (entry === undefined) return { ...report, skipped: "none-installed" };
    if (entry.source?.source !== undefined && LOCAL_MARKETPLACE_SOURCES.has(entry.source.source)) {
      if (!(await this.isPackageMarketplace(entry.source.path))) return { ...report, skipped: "dev-marketplace" };
    }

    const refresh = await this.deps.runZcode(["plugins", "marketplace", "update", TEA_RAGS_MARKETPLACE]);
    if (refresh.missing) return { ...report, skipped: "cli-missing" };
    if (refresh.code !== 0) {
      report.failed.push({ id: MARKETPLACE_FAILURE_ID, reason: runFailure(refresh) });
      return report;
    }

    const catalogList = await this.deps.runZcode(["plugins", "list", "--available", "--json"]);
    const catalog = new Map(
      ((parseJson(catalogList.stdout) as { available?: ZcodePluginRow[] } | undefined)?.available ?? [])
        .filter((row) => row.marketplace === TEA_RAGS_MARKETPLACE && typeof row.name === "string")
        .map((row) => [row.name as string, typeof row.version === "string" ? row.version : ""]),
    );

    const targets: { id: string; name: string; from: string; to: string }[] = [];
    for (const plugin of installed) {
      const latest = catalog.get(plugin.name);
      if (latest === undefined || latest === "") {
        report.failed.push({ id: plugin.id, reason: `not in the ${TEA_RAGS_MARKETPLACE} marketplace catalog` });
        continue;
      }
      if (!isValidSemver(latest) || !isValidSemver(plugin.version)) {
        report.failed.push({
          id: plugin.id,
          reason: `unparseable version (installed ${plugin.version}, catalog ${latest})`,
        });
        continue;
      }
      if (compareSemver(latest, this.deps.clientVersion) > 0) {
        report.failed.push({
          id: plugin.id,
          reason: `marketplace serves ${latest} past the client ${this.deps.clientVersion} — not updating past the client`,
        });
        continue;
      }
      if (compareSemver(latest, plugin.version) <= 0) continue;
      targets.push({ id: plugin.id, name: plugin.name, from: plugin.version, to: latest });
    }

    for (const target of targets) {
      const run = await this.deps.runZcode(["plugins", "update", target.name]);
      if (run.missing) return { ...report, skipped: "cli-missing" };
      if (run.code !== 0) {
        report.failed.push({ id: target.id, reason: runFailure(run) });
        continue;
      }
      report.updated.push({ id: target.id, oldVersion: target.from, newVersion: target.to });
    }
    return report;
  }

  /** True when the marketplace directory is this package's own `harness/zcode` (symlinks resolved). */
  private async isPackageMarketplace(path: string | undefined): Promise<boolean> {
    if (path === undefined) return false;
    const fsImpl = this.deps.fs ?? (await import("node:fs/promises"));
    const toReal = async (candidate: string): Promise<string | null> => {
      try {
        return await fsImpl.realpath(candidate);
      } catch {
        return null;
      }
    };
    const marketplace = await toReal(path);
    const packaged = await toReal(join(this.deps.packageRoot, "harness", "zcode"));
    return marketplace !== null && marketplace === packaged;
  }
}

function installedRows(stdout: string): { id: string; name: string; version: string }[] {
  const rows = (parseJson(stdout) as ZcodePluginRow[] | undefined) ?? [];
  return rows
    .filter(
      (row): row is { id: string; name: string; version: string } =>
        row.marketplace === TEA_RAGS_MARKETPLACE &&
        typeof row.id === "string" &&
        typeof row.name === "string" &&
        typeof row.version === "string",
    )
    .map((row) => ({ id: row.id, name: row.name, version: row.version }));
}

/** Parsed stdout, or undefined when the CLI printed no (valid) JSON document. */
function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

function runFailure(run: { code: number | null; stdout: string; stderr?: string }): string {
  const stderr = run.stderr?.trim().split("\n")[0];
  if (stderr) return stderr;
  const stdout = run.stdout.trim().split("\n")[0];
  if (stdout) return stdout;
  return `zcode exited with code ${run.code ?? "unknown"}`;
}

/**
 * Where the ZCode CLI lives, tried in order: `$TEA_RAGS_ZCODE_CLI`, `zcode` on
 * PATH, the macOS app bundle's bundled CLI (verified 0.17.0: `plugins
 * list|install|update|marketplace …`, `--json` on the list commands). The first
 * candidate that spawns wins and is reused; every call starts with a cheap
 * always-safe probe, so a `missing` result walks to the next candidate.
 */
export const ZCODE_CLI_CANDIDATES = ["zcode", "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"] as const;

/** A runner that walks the candidates (any `$TEA_RAGS_ZCODE_CLI` override first) until one spawns. */
export function zcodeCliRunner(
  spawn: typeof nodeSpawn,
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = [
    ...(env.TEA_RAGS_ZCODE_CLI ? [env.TEA_RAGS_ZCODE_CLI] : []),
    ...ZCODE_CLI_CANDIDATES,
  ],
): HarnessCliRunner {
  let resolved: string | null = null;
  return async (args, options) => {
    for (const command of resolved === null ? candidates : [resolved]) {
      const run = await spawnCliCommand(spawn, command)(args, options);
      if (!run.missing) {
        resolved = command;
        return run;
      }
    }
    return { code: null, stdout: "", stderr: "", missing: true };
  };
}
