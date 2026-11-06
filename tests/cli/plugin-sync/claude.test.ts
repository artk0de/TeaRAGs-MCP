import { describe, expect, it, vi } from "vitest";

import { ClaudePluginSyncAdapter } from "../../../src/cli/plugin-sync/claude.js";
import type { HarnessCliRunOptions, HarnessCliRunResult } from "../../../src/cli/plugin-sync/types.js";

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
  return vi.fn(async (args: string[], _options?: HarnessCliRunOptions) => {
    const queue = queues.get(args.join(" "));
    if (!queue || queue.length === 0) return { code: 1, stdout: "", missing: false };
    return queue.length > 1 ? (queue.shift() as HarnessCliRunResult) : queue[0];
  });
}

async function sync(runClaude: ReturnType<typeof makeRunClaude>) {
  return new ClaudePluginSyncAdapter({ runClaude, clientVersion: "1.50.0" }).sync();
}

describe("ClaudePluginSyncAdapter", () => {
  it.each([
    { stdout: "{broken", code: null, reason: "claude exited with code unknown" },
    { stdout: '{"outcome":"failed","failureCode":"download-rejected"}', code: 1, reason: "download-rejected" },
    { stdout: '{"outcome":"failed","message":"update rejected"}', code: 1, reason: "update rejected" },
  ])("reports a failed in-place update without inventing a result: $reason", async ({ stdout, code, reason }) => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.54.0"]),
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.50.0",
      }),
      "plugin update tea-rags@tea-rags --json": { stdout, code, missing: false },
    });
    expect((await sync(runClaude)).failed).toEqual([{ id: "tea-rags@tea-rags", reason }]);
  });

  it("reports a scoped install without its project path even when no re-pin is needed", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.54.0", "project"]),
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.50.0",
      }),
    });
    const report = await sync(runClaude);
    expect(report.failed).toEqual([
      { id: "tea-rags@tea-rags", reason: expect.stringContaining("project Claude did not name") },
    ]);
    expect(runClaude).toHaveBeenCalledTimes(2);
  });

  it.each(["{broken", "null", "{}"])(
    "treats an unreadable installed-plugin inventory as unknown: %s",
    async (stdout) => {
      const runClaude = makeRunClaude({ [PLUGIN_LIST]: { code: 0, stdout, missing: false } });
      expect((await sync(runClaude)).skipped).toBe("none-installed");
      expect(runClaude).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a missing marketplace that could not be added after a malformed inventory", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.54.0"]),
      [MARKETPLACE_LIST]: { code: 0, stdout: "{broken", missing: false },
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ message: "tag unavailable" }, 1),
    });
    expect((await sync(runClaude)).failed).toEqual([{ id: "tea-rags marketplace", reason: "tag unavailable" }]);
  });

  it("stops before changing the pin when marketplace removal fails", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.54.0"]),
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.49.0",
      }),
      "plugin marketplace remove tea-rags --json": line({ message: "removal denied" }, 1),
    });
    expect((await sync(runClaude)).failed).toEqual([{ id: "tea-rags marketplace", reason: "removal denied" }]);
    expect(runClaude).toHaveBeenCalledTimes(3);
  });

  it("reports a reinstall failure after a successful re-pin", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: [plugins(["tea-rags@tea-rags", "0.54.0"]), line([])],
      [MARKETPLACE_LIST]: marketplace({
        source: "git",
        url: "https://github.com/artk0de/TeaRAGs-MCP.git",
        ref: "v1.49.0",
      }),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "ok" }),
      "plugin install tea-rags@tea-rags --scope user --json": line({ message: "install rejected" }, 1),
    });
    const report = await sync(runClaude);
    expect(report.repinned?.to).toBe("v1.50.0");
    expect(report.failed).toEqual([{ id: "tea-rags@tea-rags", reason: "install rejected" }]);
  });

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
    // 6m43s: a project install whose projectPath Claude did not report cannot be
    // put back, so the re-pin must not remove the marketplace that serves it.
    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([PLUGIN_LIST, MARKETPLACE_LIST]);
    expect(report.repinDeferred).toEqual({ to: "v1.50.0", scopedIds: ["tea-rags@tea-rags (project)"] });
    expect(report.repinned).toBeUndefined();
  });

  it("refuses the re-pin in background mode while a plugin is installed with project or local scope", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: plugins(["tea-rags@tea-rags", "0.44.7", "user"], ["dinopowers@tea-rags", "0.22.4", "local"]),
      [MARKETPLACE_LIST]: marketplace({ source: "github", repo: "artk0de/TeaRAGs-MCP" }),
    });

    const report = await new ClaudePluginSyncAdapter({
      runClaude,
      clientVersion: "1.50.0",
      repinScopedInstalls: false,
    }).sync();

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([PLUGIN_LIST, MARKETPLACE_LIST]);
    expect(report.repinned).toBeUndefined();
    expect(report.repinDeferred).toEqual({ to: "v1.50.0", scopedIds: ["dinopowers@tea-rags (local)"] });
  });

  it("still re-pins in background mode when every plugin is user-scoped", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: [plugins(["tea-rags@tea-rags", "0.44.7"]), line([])],
      [MARKETPLACE_LIST]: marketplace({ source: "github", repo: "artk0de/TeaRAGs-MCP" }),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
      [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "ok" }),
      "plugin install tea-rags@tea-rags --scope user --json": line({ outcome: "ok", newVersion: "0.54.4" }),
    });

    const report = await new ClaudePluginSyncAdapter({
      runClaude,
      clientVersion: "1.50.0",
      repinScopedInstalls: false,
    }).sync();

    expect(report.repinDeferred).toBeUndefined();
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

describe("ClaudePluginSyncAdapter — one plugin installed in several scopes (6m43s)", () => {
  const PROJECT = "/abs/proj";
  const LOCAL = "/abs/other";
  const GIT_MARKETPLACE = { source: "git", url: "https://github.com/artk0de/TeaRAGs-MCP.git", ref: "v1.49.0" };
  const userAndScopedRows = (version: string, scope: "project" | "local", projectPath: string) =>
    line([
      { id: "tea-rags@tea-rags", version, scope: "user" },
      { id: "tea-rags@tea-rags", version, scope, projectPath },
    ]);

  it("background run defers a re-pin when the same id is installed at user AND project scope", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: userAndScopedRows("0.44.1", "project", PROJECT),
      [MARKETPLACE_LIST]: marketplace(GIT_MARKETPLACE),
      "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
    });

    const report = await new ClaudePluginSyncAdapter({
      runClaude,
      clientVersion: "1.50.0",
      repinScopedInstalls: false,
    }).sync();

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).not.toContain("plugin marketplace remove tea-rags --json");
    expect(report.repinDeferred).toEqual({ to: "v1.50.0", scopedIds: ["tea-rags@tea-rags (project)"] });
  });

  it.each([
    ["project", PROJECT],
    ["local", LOCAL],
  ] as const)(
    "manual run re-pins and reinstalls both the user and the %s install, the scoped one from its projectPath",
    async (scope, projectPath) => {
      const runClaude = makeRunClaude({
        [PLUGIN_LIST]: [
          userAndScopedRows("0.44.1", scope, projectPath),
          userAndScopedRows("0.54.4", scope, projectPath),
        ],
        [MARKETPLACE_LIST]: marketplace(GIT_MARKETPLACE),
        "plugin marketplace remove tea-rags --json": line({ outcome: "ok" }),
        [`plugin marketplace add ${PINNED_SOURCE} --json`]: line({ outcome: "ok" }),
        "plugin install tea-rags@tea-rags --scope user --json": line({ outcome: "ok" }),
        [`plugin install tea-rags@tea-rags --scope ${scope} --json`]: line({ outcome: "ok" }),
      });

      const report = await sync(runClaude);

      expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([
        PLUGIN_LIST,
        MARKETPLACE_LIST,
        "plugin marketplace remove tea-rags --json",
        `plugin marketplace add ${PINNED_SOURCE} --json`,
        "plugin install tea-rags@tea-rags --scope user --json",
        `plugin install tea-rags@tea-rags --scope ${scope} --json`,
        PLUGIN_LIST,
      ]);
      const scopedInstall = runClaude.mock.calls.find((c) => c[0].join(" ").includes(`--scope ${scope}`));
      expect(scopedInstall?.[1]).toEqual({ cwd: projectPath });
      expect(report.repinned).toEqual({ from: "v1.49.0", to: "v1.50.0" });
      expect(report.failed).toEqual([]);
      expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.44.1", newVersion: "0.54.4" }]);
    },
  );

  it("updates each scope of a multi-scope id in place once, the scoped one from its projectPath", async () => {
    const runClaude = makeRunClaude({
      [PLUGIN_LIST]: userAndScopedRows("0.54.0", "project", PROJECT),
      [MARKETPLACE_LIST]: marketplace({ ...GIT_MARKETPLACE, ref: "v1.50.0" }),
      "plugin update tea-rags@tea-rags --json": line({ outcome: "ok", oldVersion: "0.54.0", newVersion: "0.54.4" }),
      "plugin update tea-rags@tea-rags --scope project --json": line({
        outcome: "ok",
        oldVersion: "0.54.0",
        newVersion: "0.54.4",
      }),
    });

    const report = await sync(runClaude);

    expect(runClaude.mock.calls.map((c) => c[0].join(" "))).toEqual([
      PLUGIN_LIST,
      MARKETPLACE_LIST,
      "plugin update tea-rags@tea-rags --json",
      "plugin update tea-rags@tea-rags --scope project --json",
    ]);
    expect(runClaude.mock.calls[3][1]).toEqual({ cwd: PROJECT });
    expect(report.updated).toEqual([{ id: "tea-rags@tea-rags", oldVersion: "0.54.0", newVersion: "0.54.4" }]);
    expect(report.failed).toEqual([]);
  });
});
