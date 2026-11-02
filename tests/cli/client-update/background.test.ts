import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runBackgroundClientUpdate,
  type BackgroundClientUpdateDeps,
} from "../../../src/cli/client-update/background.js";
import { isLinkedGlobalInstall, liveIndexWorkers } from "../../../src/cli/client-update/guards.js";
import { ClientUpdateStateStore } from "../../../src/cli/client-update/state-store.js";
import type { IndexWorkerRecord } from "../../../src/cli/index-progress/worker-registry.js";
import type { HarnessPluginSyncReport } from "../../../src/cli/plugin-sync/index.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

let dataDir: string;
let store: ClientUpdateStateStore;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "client-update-bg-"));
  store = new ClientUpdateStateStore(join(dataDir, "client-update-state.json"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const worker: IndexWorkerRecord = {
  pid: 4242,
  supervisorPid: 1,
  startedAtMs: NOW,
  entryScript: "/x/build/cli/index.js",
  projectPath: "/repo",
  lastProgressAtMs: NOW,
};

function cleanSync(): HarnessPluginSyncReport {
  return {
    harnesses: [{ harness: "claude", report: { updated: [], failed: [], needsConfirmation: [] } }],
  };
}

function deps(overrides: Partial<BackgroundClientUpdateDeps> = {}) {
  const lines: string[] = [];
  const base: BackgroundClientUpdateDeps = {
    currentVersion: () => "1.50.0",
    releaseTimeline: vi.fn(async () => ({
      latest: "1.52.0",
      publishedAt: { "1.50.0": ago(30), "1.51.0": ago(4), "1.52.0": ago(1) },
    })),
    isDevInstall: vi.fn(async () => false),
    liveWorkers: () => [],
    install: vi.fn(async (version: string) => ({ kind: "installed" as const, version })),
    syncPlugins: vi.fn(async () => cleanSync()),
    store,
    clock: () => NOW,
    out: (line: string) => lines.push(line),
  };
  return { d: { ...base, ...overrides }, lines };
}

describe("runBackgroundClientUpdate", () => {
  it("installs the newest canary-eligible release, syncs plugins to it and asks for an MCP reconnect", async () => {
    const { d, lines } = deps();
    expect(await runBackgroundClientUpdate(d)).toBe(0);
    expect(d.install).toHaveBeenCalledWith("1.51.0");
    expect(d.syncPlugins).toHaveBeenCalledWith("1.51.0");
    expect(lines.join("\n")).toContain("/mcp reconnect");
    expect(store.read()).toMatchObject({ lastCompletedAt: NOW, consecutiveFailures: 0 });
  });

  it("is a stamped no-op when no newer release passed its canary window", async () => {
    const { d, lines } = deps({
      releaseTimeline: async () => ({ latest: "1.51.0", publishedAt: { "1.50.0": ago(30), "1.51.0": ago(1) } }),
    });
    expect(await runBackgroundClientUpdate(d)).toBe(0);
    expect(d.install).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/canary/);
    expect(store.read().lastCompletedAt).toBe(NOW);
  });

  it("skips a dev install (npm link) and says so", async () => {
    const { d, lines } = deps({ isDevInstall: async () => true });
    await runBackgroundClientUpdate(d);
    expect(d.releaseTimeline).not.toHaveBeenCalled();
    expect(d.install).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/npm link/);
  });

  it("defers while an index worker is live and leaves the 24 h throttle unstamped", async () => {
    const { d, lines } = deps({ liveWorkers: () => [worker] });
    await runBackgroundClientUpdate(d);
    expect(d.install).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/4242/);
    expect(store.read().lastCompletedAt).toBeUndefined();
  });

  it("records a failed install for backoff", async () => {
    const { d, lines } = deps({ install: async () => ({ kind: "failed", exitCode: 243 }) });
    expect(await runBackgroundClientUpdate(d)).toBe(243);
    expect(d.syncPlugins).not.toHaveBeenCalled();
    expect(store.read()).toMatchObject({ lastFailureAt: NOW, consecutiveFailures: 1 });
    expect(lines.join("\n")).toMatch(/failed/);
  });

  it("records an unreachable registry as a failure", async () => {
    const { d } = deps({ releaseTimeline: async () => null });
    expect(await runBackgroundClientUpdate(d)).toBe(1);
    expect(store.read().consecutiveFailures).toBe(1);
  });

  it("leaves a manual-update hint when the Claude re-pin was refused for project/local-scope installs", async () => {
    const { d, lines } = deps({
      syncPlugins: async () => ({
        harnesses: [
          {
            harness: "claude",
            report: {
              updated: [],
              failed: [],
              needsConfirmation: [],
              repinDeferred: { to: "v1.51.0", scopedIds: ["tea-rags@tea-rags (project)"] },
            },
          },
        ],
      }),
    });
    await runBackgroundClientUpdate(d);
    expect(store.read().manualUpdateHint).toContain("tea-rags update");
    expect(lines.join("\n")).toContain("tea-rags@tea-rags (project)");
  });

  it("clears an older manual-update hint once a background sync needed no refusal", async () => {
    store.update({ manualUpdateHint: "stale" });
    const { d } = deps();
    await runBackgroundClientUpdate(d);
    expect(store.read().manualUpdateHint).toBeUndefined();
  });
});

describe("background guards", () => {
  it("detects a global package dir that is a symlink as a dev install", async () => {
    const real = join(dataDir, "checkout");
    mkdirSync(real);
    const linkRoot = join(dataDir, "lib", "node_modules");
    mkdirSync(linkRoot, { recursive: true });
    symlinkSync(real, join(linkRoot, "tea-rags"));
    expect(await isLinkedGlobalInstall(async () => linkRoot)).toBe(true);

    const plainRoot = join(dataDir, "plain");
    mkdirSync(join(plainRoot, "tea-rags"), { recursive: true });
    expect(await isLinkedGlobalInstall(async () => plainRoot)).toBe(false);
    expect(await isLinkedGlobalInstall(async () => null)).toBe(false);
  });

  it("counts only index workers whose pid is alive", () => {
    const registry = { list: () => [worker, { ...worker, pid: 7 }] };
    expect(liveIndexWorkers(registry, (pid) => pid === 4242).map((w) => w.pid)).toEqual([4242]);
  });
});
