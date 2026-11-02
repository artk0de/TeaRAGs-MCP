import { describe, expect, it, vi } from "vitest";

import { ClaudePluginSyncAdapter } from "../../../src/cli/plugin-sync/claude.js";
import type { HarnessCliRunResult } from "../../../src/cli/plugin-sync/types.js";

const PLUGIN_LIST = "plugin list --json";
const MARKETPLACE_LIST = "plugin marketplace list --json";
const PINNED_SOURCE = "https://github.com/artk0de/TeaRAGs-MCP.git#v1.50.0";

function line(value: object, code = 0): HarnessCliRunResult {
  return { code, stdout: `${JSON.stringify(value)}\n`, missing: false };
}

function plugins(...entries: [string, string, string?][]): HarnessCliRunResult {
  return line(entries.map(([id, version, scope]) => ({ id, version, scope: scope ?? "user" })));
}

function marketplace(entry: Record<string, unknown>): HarnessCliRunResult {
  return line([
    { name: "other", source: "github", repo: "x/y" },
    { name: "tea-rags", ...entry },
  ]);
}

/** Answers by joined argument line; an array answers successive calls in order. */
function makeRunClaude(answers: Record<string, HarnessCliRunResult | HarnessCliRunResult[]>) {
  const queues = new Map(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
  return vi.fn(async (args: string[]) => {
    const queue = queues.get(args.join(" "));
    if (!queue || queue.length === 0) return { code: 1, stdout: "", missing: false };
    return queue.length > 1 ? (queue.shift() as HarnessCliRunResult) : queue[0];
  });
}

async function sync(runClaude: ReturnType<typeof makeRunClaude>) {
  return new ClaudePluginSyncAdapter({ runClaude, clientVersion: "1.50.0" }).sync();
}

describe("ClaudePluginSyncAdapter", () => {
  it("re-pins a marketplace at another ref to v<client version> and reinstalls the plugins the removal uninstalled", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: [
        plugins(["tea-rags@tea-rags", "0.44.7"], ["dinopowers@tea-rags", "0.22.4"]),
        plugins(["tea-rags@tea-rags", "0.54.4"], ["dinopowers@tea-rags", "0.22.4"]),
      ],
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.49.0",
      }),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "ok" }),
      "plugin install tea-rags@tea-rags --scope user --json": line({ outcome: "ok" }),
      "plugin install dinopowers@tea-rags --scope user --json": line({ outcome: "ok" }),
    });

    const report = await sync(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([
      PLUGIN_LIST,
      MARKETPLACE_LIST,
      "plugin marketplace remove tea-rags --json",
      `plugin marketplace add ${PINNED_SOURCE} --json`,
      "plugin install tea-rags@tea-rags --scope user --json",
      "plugin install dinopowers@tea-rags --scope user --json",
      PLUGIN_LIST,
    ]);
    expect(runClaude.mock.calls.flatMap((c) => c[0])).not.toContain("-y");
    expect(report.repinned).toEqual({ from: "v1.49.0", to: "v1.50.0" });
    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.44.7", newVersion: "0.54.4" }]);
    expect(report.failed).toEqual([]);
  });

  it("updates each installed plugin in place when the marketplace is already pinned to the client tag", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.54.0"]),
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.50.0",
      }),
      "plugin update tea-rags@tea-rags --json": line({ outcome: "ok", oldVersion: "0.54.0", newVersion: "0.54.4" }),
    });

    const report = await sync(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([
      PLUGIN_LIST,
      MARKETPLACE_LIST,
      "plugin update tea-rags@tea-rags --json",
    ]);
    expect(report.repinned).toBeUndefined();
    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.54.0", newVersion: "0.54.4" }]);
  });

  it("does not reinstall a project-scoped plugin from an unrelated directory — reports it instead", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: [plugins(["tea-rags@tea-rags", "0.44.7", "project"]), line([])],
      [MARKETPLACE_LIST]: marketplace({ source: "github", repo: "artk0de/TeaRAGs-MCP" }),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "ok" }),
    });

    const report = await sync(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" ")).some((l) => l.startsWith("plugin install"))).toBe(false);
    expect(report.failed).toEqual([
      {
        id: "tea-rags@tea-rags",
        reason: expect.stringContaining("claude plugin install tea-rags@tea-rags --scope project"),
      },
    ]);
    expect(report.repinned).toEqual({ from: "artk0de/TeaRAGs-MCP", to: "v1.50.0" });
  });

  it("surfaces a marketplace-declared command on reinstall for confirmation instead of accepting it", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: [plugins(["tea-rags@tea-rags", "0.44.7"]), line([])],
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.49.0",
      }),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "ok" }),
      "plugin install tea-rags@tea-rags --scope user --json": line(
        { outcome: "failed", shownCommand: { command: "npm ci", sha256: "abc" } },
        1,
      ),
    });

    const report = await sync(runClaude);

    expect(report.needsConfirmation).toEqual([
      {
        id: "tea-rags@tea-rags",
        command: "npm ci",
        sha256: "abc",
        acceptWith: "claude plugin install tea-rags@tea-rags --scope user --accept-command abc",
      },
    ]);
    expect(runClaude.mock.calls.flatMap((c) => c[0])).not.toContain("--accept-command");
  });

  it("restores the previous marketplace source when adding the pinned one fails", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: [plugins(["tea-rags@tea-rags", "0.44.7"]), plugins(["tea-rags@tea-rags", "0.44.7"])],
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.49.0",
      }),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "failed", message: "tag not found" }, 1),
      "plugin marketplace add https://github.com/artk0de/TeaRAGs-MCP.git#v1.49.0 --json": line({ outcome: "ok" }),
      "plugin install tea-rags@tea-rags --scope user --json": line({ outcome: "ok" }),
    });

    const report = await sync(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toContain(
      "plugin marketplace add https://github.com/artk0de/TeaRAGs-MCP.git#v1.49.0 --json",
    );
    expect(report.failed).toEqual([{ id: "tea-rags marketplace", reason: "tag not found" }]);
    expect(report.repinned).toBeUndefined();
  });

  it("leaves a local-directory marketplace (developer checkout) alone", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.44.7"]),
      [MARKETPLACE_LIST]: marketplace({ source: "directory", path: "/dev/tea-rags-mcp" }),
    });

    const report = await sync(runClaude);

    expect(report.skipped).toBe("dev-marketplace");
    expect(runClaude).toHaveBeenCalledTimes(2);
  });

  it("reports cli-missing and none-installed without touching the marketplace", async () => {
    const missing = vi.fn(async () => ({ code: null, stdout: "", missing: true }));
    expect((await sync(missing as never)).skipped).toBe("cli-missing");

    const none = makeRunClaude({ [PLUGIN_LIST]: plugins(["other@elsewhere", "1.0.0"]) });
    expect((await sync(none)).skipped).toBe("none-installed");
    expect(none).toHaveBeenCalledTimes(1);
  });
});
