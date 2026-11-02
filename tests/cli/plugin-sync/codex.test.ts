import { describe, expect, it, vi } from "vitest";

import { CodexPluginSyncAdapter } from "../../../src/cli/plugin-sync/codex.js";
import type { HarnessCliRunResult } from "../../../src/cli/plugin-sync/types.js";

const CLIENT_VERSION = "1.50.0";
const MARKETPLACE_LIST = "plugin marketplace list --json";
const PLUGIN_LIST = "plugin list --json --marketplace tea-rags";

function json(value: object, code = 0): HarnessCliRunResult {
  return { code, stdout: `${JSON.stringify(value, null, 2)}\n`, missing: false };
}

/** Answers each `codex …` invocation by its joined argument line; unknown lines fail. */
function makeRunCodex(answers: Record<string, HarnessCliRunResult | HarnessCliRunResult[]>) {
  const queues = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return vi.fn(async (args: string[]) => {
    const queue = queues.get(args.join(" "));
    if (!queue || queue.length === 0) return { code: 1, stdout: "", missing: false };
    return queue.length > 1 ? (queue.shift() as HarnessCliRunResult) : queue[0];
  });
}

function marketplaces(sourceType: "git" | "local") {
  return json({
    marketplaces: [
      { name: "openai-bundled", root: "/x", marketplaceSource: { sourceType: "local", source: "/x" } },
      {
        name: "tea-rags",
        root: "/codex/.tmp/marketplaces/tea-rags",
        marketplaceSource: { sourceType, source: "https://github.com/artk0de/TeaRAGs-MCP.git" },
      },
    ],
  });
}

function installed(...plugins: [string, string][]) {
  return json({
    installed: plugins.map(([pluginId, version]) => ({ pluginId, version, installed: true, enabled: true })),
    available: [],
  });
}

function configToml(ref: string): string {
  return [
    "[marketplaces.openai-bundled]",
    'source_type = "local"',
    "",
    "[marketplaces.tea-rags]",
    'source_type = "git"',
    'source = "https://github.com/artk0de/TeaRAGs-MCP.git"',
    `ref = "${ref}"`,
    'sparse_paths = [".agents", "harness/codex"]',
    "",
  ].join("\n");
}

function adapter(runCodex: ReturnType<typeof makeRunCodex>, toml = configToml("v1.49.0")) {
  return new CodexPluginSyncAdapter({
    runCodex,
    clientVersion: CLIENT_VERSION,
    codexHome: "/codex",
    fs: { readFile: vi.fn(async () => toml) as never },
  });
}

describe("CodexPluginSyncAdapter", () => {
  it("re-pins a marketplace at another tag to v<client version>, then refreshes every installed plugin", async () => {
    const runCodex = makeRunCodex({
      [MARKETPLACE_LIST]: marketplaces("git"),
      [PLUGIN_LIST]: installed(["tea-rags@tea-rags", "0.53.0"], ["dinopowers@tea-rags", "0.25.1"]),
      "plugin marketplace remove tea-rags --json": json({ marketplaceName: "tea-rags" }),
      "plugin marketplace add artk0de/TeaRAGs-MCP --ref v1.50.0 --sparse .agents --sparse harness/codex --json": json({
        marketplaceName: "tea-rags",
        alreadyAdded: false,
      }),
      "plugin add tea-rags@tea-rags --json": json({ pluginId: "tea-rags@tea-rags", version: "0.54.4" }),
      "plugin add dinopowers@tea-rags --json": json({ pluginId: "dinopowers@tea-rags", version: "0.25.1" }),
    });

    const report = await adapter(runCodex).sync();

    expect(runCodex.mock.calls.map((c) => c[0].join(" "))).toEqual([
      MARKETPLACE_LIST,
      PLUGIN_LIST,
      "plugin marketplace remove tea-rags --json",
      "plugin marketplace add artk0de/TeaRAGs-MCP --ref v1.50.0 --sparse .agents --sparse harness/codex --json",
      "plugin add tea-rags@tea-rags --json",
      "plugin add dinopowers@tea-rags --json",
    ]);
    expect(report.repinned).toEqual({ from: "v1.49.0", to: "v1.50.0" });
    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.53.0", newVersion: "0.54.4" }]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toBeUndefined();
  });

  it("leaves an already pinned marketplace in place and only refreshes the installed plugins", async () => {
    const runCodex = makeRunCodex({
      [MARKETPLACE_LIST]: marketplaces("git"),
      [PLUGIN_LIST]: installed(["tea-rags@tea-rags", "0.54.4"]),
      "plugin add tea-rags@tea-rags --json": json({ pluginId: "tea-rags@tea-rags", version: "0.54.4" }),
    });

    const report = await adapter(runCodex, configToml("v1.50.0")).sync();

    expect(runCodex.mock.calls.map((c) => c[0].join(" "))).toEqual([
      MARKETPLACE_LIST,
      PLUGIN_LIST,
      "plugin add tea-rags@tea-rags --json",
    ]);
    expect(report.repinned).toBeUndefined();
    expect(report.updated).toEqual([]);
  });

  it("restores the previous source when adding the pinned marketplace fails", async () => {
    const runCodex = makeRunCodex({
      [MARKETPLACE_LIST]: marketplaces("git"),
      [PLUGIN_LIST]: installed(["tea-rags@tea-rags", "0.53.0"]),
      "plugin marketplace remove tea-rags --json": json({ marketplaceName: "tea-rags" }),
      "plugin marketplace add https://github.com/artk0de/TeaRAGs-MCP.git --ref v1.49.0 --sparse .agents --sparse harness/codex --json":
        json({ marketplaceName: "tea-rags" }),
      "plugin add tea-rags@tea-rags --json": json({ pluginId: "tea-rags@tea-rags", version: "0.53.0" }),
    });

    const report = await adapter(runCodex).sync();

    expect(runCodex.mock.calls.map((c) => c[0].join(" "))).toContain(
      "plugin marketplace add https://github.com/artk0de/TeaRAGs-MCP.git --ref v1.49.0 --sparse .agents --sparse harness/codex --json",
    );
    expect(report.failed.map((f) => f.id)).toEqual(["tea-rags marketplace"]);
    expect(report.repinned).toBeUndefined();
  });

  it("skips a local-directory marketplace (developer checkout) as dev-marketplace", async () => {
    const runCodex = makeRunCodex({ [MARKETPLACE_LIST]: marketplaces("local") });

    const report = await adapter(runCodex).sync();

    expect(report.skipped).toBe("dev-marketplace");
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it("reports none-installed when no *@tea-rags plugin is installed", async () => {
    const runCodex = makeRunCodex({
      [MARKETPLACE_LIST]: marketplaces("git"),
      [PLUGIN_LIST]: installed(["browser@openai-bundled", "1.0.0"]),
    });

    const report = await adapter(runCodex).sync();

    expect(report.skipped).toBe("none-installed");
    expect(runCodex).toHaveBeenCalledTimes(2);
  });

  it("reports none-installed when the tea-rags marketplace is not configured", async () => {
    const runCodex = makeRunCodex({ [MARKETPLACE_LIST]: json({ marketplaces: [] }) });

    const report = await adapter(runCodex).sync();

    expect(report.skipped).toBe("none-installed");
  });

  it("reports cli-missing when codex is not on PATH", async () => {
    const runCodex = vi.fn(async () => ({ code: null, stdout: "", missing: true }));

    const report = await adapter(runCodex).sync();

    expect(report.skipped).toBe("cli-missing");
    expect(runCodex).toHaveBeenCalledTimes(1);
  });
});
