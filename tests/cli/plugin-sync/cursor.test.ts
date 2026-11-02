import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CursorPluginSyncAdapter } from "../../../src/cli/plugin-sync/cursor.js";

let root: string;
let home: string;
let packageRoot: string;

async function writePlugin(dir: string, version: string, marker: string): Promise<void> {
  await fs.mkdir(join(dir, ".cursor-plugin"), { recursive: true });
  await fs.writeFile(join(dir, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "p", version }));
  await fs.writeFile(join(dir, "marker.txt"), marker);
}

const localDir = (name: string) => join(home, ".cursor", "plugins", "local", name);
const readMarker = async (name: string) => fs.readFile(join(localDir(name), "marker.txt"), "utf-8");

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "cursor-plugin-sync-"));
  home = join(root, "home");
  packageRoot = join(root, "pkg");
  await writePlugin(join(packageRoot, "harness", "cursor", "tea-rags"), "0.54.4", "packaged tea-rags");
  await writePlugin(join(packageRoot, "harness", "cursor", "dinopowers"), "0.25.1", "packaged dinopowers");
  await fs.writeFile(join(packageRoot, "harness", "cursor", "README.md"), "docs");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function adapter() {
  return new CursorPluginSyncAdapter({ homedir: home, packageRoot, fs });
}

describe("CursorPluginSyncAdapter", () => {
  it("replaces an installed plugin whose version differs from the packaged copy, leaving no staging/old dirs", async () => {
    await writePlugin(localDir("tea-rags"), "0.53.0", "installed tea-rags");
    await fs.writeFile(join(localDir("tea-rags"), "stale.txt"), "gone after replace");

    const report = await adapter().sync();

    expect(report.updated).toEqual([{ id: "tea-rags", oldVersion: "0.53.0", newVersion: "0.54.4" }]);
    expect(await readMarker("tea-rags")).toBe("packaged tea-rags");
    await expect(fs.access(join(localDir("tea-rags"), "stale.txt"))).rejects.toThrow();
    const entries = await fs.readdir(join(home, ".cursor", "plugins", "local"));
    expect(entries.sort()).toEqual(["tea-rags"]);
    const stat = await fs.lstat(localDir("tea-rags"));
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it("leaves an installed plugin at the packaged version untouched", async () => {
    await writePlugin(localDir("dinopowers"), "0.25.1", "installed dinopowers");

    const report = await adapter().sync();

    expect(report.updated).toEqual([]);
    expect(report.skipped).toBeUndefined();
    expect(await readMarker("dinopowers")).toBe("installed dinopowers");
  });

  it("never installs a packaged plugin that is absent and never touches foreign plugins", async () => {
    await writePlugin(localDir("someone-else"), "0.0.1", "foreign");

    const report = await adapter().sync();

    expect(report.skipped).toBe("none-installed");
    expect((await fs.readdir(join(home, ".cursor", "plugins", "local"))).sort()).toEqual(["someone-else"]);
    expect(await readMarker("someone-else")).toBe("foreign");
  });

  it("reports none-installed when ~/.cursor/plugins/local does not exist", async () => {
    const report = await adapter().sync();

    expect(report.skipped).toBe("none-installed");
    await expect(fs.access(join(home, ".cursor"))).rejects.toThrow();
  });
});
