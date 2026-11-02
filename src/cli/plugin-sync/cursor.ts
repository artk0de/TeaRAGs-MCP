import type * as fsPromises from "node:fs/promises";
import { join } from "node:path";

import { emptyPluginSyncReport, type HarnessPluginSyncAdapter, type PluginSyncReport } from "./types.js";

export type CursorPluginFs = Pick<typeof fsPromises, "readdir" | "readFile" | "cp" | "rename" | "rm">;

export interface CursorPluginSyncDeps {
  homedir: string;
  /** Root of the installed tea-rags package — the Cursor plugin copies ship under `harness/cursor/<name>`. */
  packageRoot: string;
  fs: CursorPluginFs;
}

const MANIFEST = join(".cursor-plugin", "plugin.json");

/**
 * Cursor has no marketplace CLI: its local plugins are plain directories under
 * `~/.cursor/plugins/local/`. The tea-rags package ships the Cursor plugin
 * copies of its own release, so a copy IS the client version. Each installed
 * plugin this package ships whose manifest version differs from the packaged
 * one is replaced atomically. Plugins the package does not ship, packaged
 * plugins that are not installed, and symlinked installs are never touched.
 */
export class CursorPluginSyncAdapter implements HarnessPluginSyncAdapter {
  readonly harness = "cursor" as const;

  constructor(private readonly deps: CursorPluginSyncDeps) {}

  async sync(): Promise<PluginSyncReport> {
    const report = emptyPluginSyncReport();
    const localRoot = join(this.deps.homedir, ".cursor", "plugins", "local");
    const packagedRoot = join(this.deps.packageRoot, "harness", "cursor");
    const installed = await this.directoryNames(localRoot);
    const packaged = new Set(await this.directoryNames(packagedRoot));
    const names = installed.filter((name) => packaged.has(name));
    if (names.length === 0) return { ...report, skipped: "none-installed" };

    for (const name of names) {
      const source = join(packagedRoot, name);
      const dest = join(localRoot, name);
      const newVersion = await this.manifestVersion(source);
      if (newVersion === undefined) continue;
      const oldVersion = await this.manifestVersion(dest);
      if (oldVersion === newVersion) continue;
      try {
        await this.replaceDirectory(source, dest);
        report.updated.push({ id: name, oldVersion: oldVersion ?? "unknown", newVersion });
      } catch (err) {
        report.failed.push({ id: name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return report;
  }

  /** Real directories only — a symlinked install is a developer's own wiring. */
  private async directoryNames(dir: string): Promise<string[]> {
    try {
      const entries = await this.deps.fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  private async manifestVersion(pluginDir: string): Promise<string | undefined> {
    try {
      const manifest = JSON.parse(String(await this.deps.fs.readFile(join(pluginDir, MANIFEST), "utf-8"))) as {
        version?: unknown;
      };
      return typeof manifest.version === "string" ? manifest.version : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Copy to `<dest>.staging`, move the current install to `<dest>.old`, move
   * staging in, drop old. A failure before the swap leaves the install as it
   * was; a failed swap moves the old install back.
   */
  private async replaceDirectory(source: string, dest: string): Promise<void> {
    const { fs } = this.deps;
    const staging = `${dest}.staging`;
    const old = `${dest}.old`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.rm(old, { recursive: true, force: true });
    await fs.cp(source, staging, { recursive: true, dereference: true });
    await fs.rename(dest, old);
    try {
      await fs.rename(staging, dest);
    } catch (err) {
      await fs.rename(old, dest);
      await fs.rm(staging, { recursive: true, force: true });
      throw err;
    }
    await fs.rm(old, { recursive: true, force: true });
  }
}
