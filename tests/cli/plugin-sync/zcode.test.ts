import type { spawn as nodeSpawn } from "node:child_process";
import EventEmitter from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CLI_CANDIDATES, zcodeCliRunner, ZcodePluginSyncAdapter } from "../../../src/cli/plugin-sync/zcode.js";

let root: string;
let packageRoot: string;

interface FakeRun {
  code: number | null;
  stdout: string;
  missing?: boolean;
  stderr?: string;
}

type FakeRun0 = Omit<FakeRun, "missing">;

const ok: FakeRun0 = { code: 0, stdout: "" };

/** Answers each `zcode …` invocation by its joined argument line; unspecified lines fail. */
function makeRun(answers: Record<string, FakeRun>) {
  return vi.fn(async (args: string[]) => {
    const run = answers[args.join(" ")];
    if (run) return { missing: false, ...run };
    return { code: 1, stdout: "", stderr: "unexpected call", missing: false };
  });
}

const installedRows = (rows: { name: string; version: string }[]) =>
  JSON.stringify(
    rows.map((row) => ({
      id: `${row.name}@tea-rags`,
      name: row.name,
      marketplace: "tea-rags",
      version: row.version,
      enabled: true,
    })),
  );

const catalog = (rows: { name: string; version: string }[]) =>
  JSON.stringify({
    installed: [],
    available: rows.map((row) => ({
      id: `${row.name}@tea-rags`,
      name: row.name,
      marketplace: "tea-rags",
      version: row.version,
    })),
    diagnostics: [],
  });

const marketplaces = (source: object | null) =>
  JSON.stringify(source === null ? [] : [{ id: "tea-rags", name: "tea-rags", source }]);

/** A package root whose `harness/zcode` exists, plus a marketplace path that realpaths to it. */
let marketplacePath: string;

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "zcode-plugin-sync-"));
  packageRoot = join(root, "pkg");
  await fs.mkdir(join(packageRoot, "harness", "zcode"), { recursive: true });
  marketplacePath = join(packageRoot, "harness", "zcode");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function adapter(run: ReturnType<typeof makeRun>) {
  return new ZcodePluginSyncAdapter({ runZcode: run, clientVersion: "1.51.0", packageRoot });
}

/** The package's own directory marketplace serving 0.55.8 — the standard install channel. */
const pluginUpdates = () => ({
  "plugins list --json": { code: 0, stdout: installedRows([{ name: "tea-rags", version: "0.54.0" }]) },
  "plugins marketplace list --json": { code: 0, stdout: marketplaces({ source: "directory", path: marketplacePath }) },
  "plugins marketplace update tea-rags": ok,
  "plugins list --available --json": { code: 0, stdout: catalog([{ name: "tea-rags", version: "0.55.8" }]) },
  "plugins update tea-rags": { code: 0, stdout: "Updated plugin tea-rags@tea-rags from 0.54.0 to 0.55.8." },
});

describe("ZcodePluginSyncAdapter", () => {
  it("skips with cli-missing when the ZCode CLI is nowhere", async () => {
    const run = makeRun({});
    run.mockImplementation(async () => ({ code: null, stdout: "", missing: true }));

    const report = await adapter(run).sync();

    expect(report.skipped).toBe("cli-missing");
    expect(run).toHaveBeenCalledWith(["plugins", "list", "--json"]);
  });

  it("skips with none-installed when no plugin of the tea-rags marketplace is installed", async () => {
    const run = makeRun({
      "plugins list --json": { code: 0, stdout: installedRows([]) },
    });

    expect((await adapter(run).sync()).skipped).toBe("none-installed");
  });

  it("skips with none-installed when the tea-rags marketplace is absent", async () => {
    const run = makeRun({
      "plugins list --json": { code: 0, stdout: installedRows([{ name: "tea-rags", version: "0.55.8" }]) },
      "plugins marketplace list --json": { code: 0, stdout: marketplaces(null) },
    });

    expect((await adapter(run).sync()).skipped).toBe("none-installed");
  });

  it("skips a local marketplace that is not this package's harness/zcode (a dev checkout)", async () => {
    const other = join(root, "checkout");
    await fs.mkdir(other, { recursive: true });
    const run = makeRun({
      "plugins list --json": { code: 0, stdout: installedRows([{ name: "tea-rags", version: "0.54.0" }]) },
      "plugins marketplace list --json": { code: 0, stdout: marketplaces({ source: "directory", path: other }) },
    });

    const report = await adapter(run).sync();

    expect(report.skipped).toBe("dev-marketplace");
    expect(run).not.toHaveBeenCalledWith(["plugins", "marketplace", "update", "tea-rags"]);
  });

  it("accepts a symlinked path to the package's own harness/zcode (the npm-link install)", async () => {
    const link = join(root, "marketplace-link");
    await fs.symlink(marketplacePath, link, "dir");
    const run = makeRun({
      ...pluginUpdates(),
      "plugins marketplace list --json": { code: 0, stdout: marketplaces({ source: "directory", path: link }) },
    });

    const report = await adapter(run).sync();

    expect(report.skipped).toBeUndefined();
    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.54.0", newVersion: "0.55.8" }]);
  });

  it("updates an installed plugin to a catalog version at or below the client", async () => {
    const run = makeRun(pluginUpdates());

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.54.0", newVersion: "0.55.8" }]);
    expect(report.failed).toEqual([]);
    expect(run).toHaveBeenCalledWith(["plugins", "update", "tea-rags"]);
  });

  it("touches nothing when the installed version already matches the catalog", async () => {
    const run = makeRun({
      ...pluginUpdates(),
      "plugins list --json": { code: 0, stdout: installedRows([{ name: "tea-rags", version: "0.55.8" }]) },
    });

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(run).not.toHaveBeenCalledWith(["plugins", "update", "tea-rags"]);
  });

  it("refuses a catalog version past the client — never updates past the installed release", async () => {
    const run = makeRun({
      ...pluginUpdates(),
      "plugins list --available --json": { code: 0, stdout: catalog([{ name: "tea-rags", version: "9.9.9" }]) },
    });

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([]);
    expect(report.failed).toEqual([
      {
        id: "tea-rags@tea-rags",
        reason: "marketplace serves 9.9.9 past the client 1.51.0 — not updating past the client",
      },
    ]);
    expect(run).not.toHaveBeenCalledWith(["plugins", "update", "tea-rags"]);
  });

  it("never downgrades: a catalog version below the installed one is a no-op", async () => {
    const run = makeRun({
      ...pluginUpdates(),
      "plugins list --json": { code: 0, stdout: installedRows([{ name: "tea-rags", version: "0.56.0" }]) },
    });

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(run).not.toHaveBeenCalledWith(["plugins", "update", "tea-rags"]);
  });

  it("fails a plugin absent from the catalog and one with an unparseable version, updating the healthy one", async () => {
    const run = makeRun({
      "plugins list --json": {
        code: 0,
        stdout: installedRows([
          { name: "tea-rags", version: "0.54.0" },
          { name: "dinopowers", version: "0.25.0" },
          { name: "tea-rags-setup", version: "0.8.2" },
        ]),
      },
      "plugins marketplace list --json": {
        code: 0,
        stdout: marketplaces({ source: "github", repo: "artk0de/TeaRAGs-MCP" }),
      },
      "plugins marketplace update tea-rags": ok,
      "plugins list --available --json": {
        code: 0,
        stdout: catalog([
          { name: "tea-rags", version: "0.55.8" },
          { name: "dinopowers", version: "0.25.1-rc.1" },
        ]),
      },
      "plugins update tea-rags": { code: 0, stdout: "Updated." },
    });

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.54.0", newVersion: "0.55.8" }]);
    expect(report.failed.map((f) => f.id).sort()).toEqual(["dinopowers@tea-rags", "tea-rags-setup@tea-rags"]);
    expect(report.failed[0].reason).toContain("unparseable version");
    expect(report.failed[1].reason).toContain("not in the tea-rags marketplace catalog");
  });

  it("reports a failed marketplace refresh and stops before trusting a stale catalog", async () => {
    const run = makeRun({
      ...pluginUpdates(),
      "plugins marketplace update tea-rags": { code: 1, stdout: "", stderr: "clone failed: no network" },
    });

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([]);
    expect(report.failed).toEqual([{ id: "tea-rags marketplace", reason: "clone failed: no network" }]);
    expect(run).not.toHaveBeenCalledWith(["plugins", "update", "tea-rags"]);
  });

  it("records a failed plugin update and keeps the report going", async () => {
    const run = makeRun({
      ...pluginUpdates(),
      "plugins update tea-rags": { code: 1, stdout: "", stderr: "cache write failed" },
    });

    const report = await adapter(run).sync();

    expect(report.updated).toEqual([]);
    expect(report.failed).toEqual([{ id: "tea-rags@tea-rags", reason: "cache write failed" }]);
  });
});

/** A spawn whose candidate behavior is scripted per command string. */
function makeSpawn(byCommand: Record<string, "missing" | "ok">) {
  return vi.fn().mockImplementation((command: string) => {
    const ee: NodeJS.EventEmitter = new EventEmitter();
    setImmediate(() => {
      if ((byCommand[command] ?? "missing") === "missing") {
        ee.emit("error", Object.assign(new Error("enoent"), { code: "ENOENT" }));
        return;
      }
      ee.emit("data", "[]");
      ee.emit("close", 0);
    });
    return Object.assign(ee, { stdout: new EventEmitter(), stderr: new EventEmitter() });
  });
}

/** The mock where a real spawn is expected. */
const asSpawn = (mock: ReturnType<typeof makeSpawn>): typeof nodeSpawn =>
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- vi.fn() mock posing as spawn; the double cast is the point
  mock as unknown as typeof nodeSpawn;

describe("zcodeCliRunner", () => {
  it("walks the candidates until one spawns and then reuses it", async () => {
    const candidates = ["/nope/one", "/nope/two", "/yes/three"];
    const spawn = makeSpawn({ "/yes/three": "ok" });
    const run = zcodeCliRunner(asSpawn(spawn), {}, candidates);

    const first = await run(["plugins", "list", "--json"]);
    expect(first.missing).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(3);

    spawn.mockClear();
    const second = await run(["plugins", "marketplace", "list", "--json"]);
    expect(second.missing).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("/yes/three", ["plugins", "marketplace", "list", "--json"], expect.anything());
  });

  it("reports missing when every candidate is ENOENT", async () => {
    const spawn = makeSpawn({});
    const run = zcodeCliRunner(asSpawn(spawn), {}, ZCODE_CLI_CANDIDATES);

    expect((await run(["plugins", "list", "--json"])).missing).toBe(true);
  });

  it("puts a $TEA_RAGS_ZCODE_CLI override ahead of the default candidates", async () => {
    const spawn = makeSpawn({ "/custom/zcode": "ok" });
    const run = zcodeCliRunner(spawn, { TEA_RAGS_ZCODE_CLI: "/custom/zcode" });

    const result = await run(["plugins", "list", "--json"]);

    expect(result.missing).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith("/custom/zcode", expect.anything(), expect.anything());
  });
});
