import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientUpdateStateStore } from "../../../src/cli/client-update/state-store.js";
import { ClientUpdateTrigger } from "../../../src/cli/client-update/trigger.js";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-02T12:00:00.000Z");

let dataDir: string;
let store: ClientUpdateStateStore;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "client-update-trigger-"));
  store = new ClientUpdateStateStore(join(dataDir, "client-update-state.json"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function trigger(enabled: boolean, now = NOW) {
  const spawn = vi.fn();
  const t = new ClientUpdateTrigger({
    setting: () => ({ enabled, source: "default" }),
    store,
    spawn,
    clock: () => now,
  });
  return { t, spawn };
}

describe("ClientUpdateTrigger", () => {
  it("spawns the background update when the setting is on and nothing ran yet, and stamps the spawn", () => {
    const { t, spawn } = trigger(true);
    expect(t.maybeSpawn()).toBe("spawned");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(store.read().lastSpawnAt).toBe(NOW);
  });

  it("never spawns when the setting is off", () => {
    const { t, spawn } = trigger(false);
    expect(t.maybeSpawn()).toBe("disabled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("throttles to one completed run per 24 h", () => {
    store.update({ lastCompletedAt: NOW - 23 * HOUR });
    const fresh = trigger(true);
    expect(fresh.t.maybeSpawn()).toBe("throttled");
    expect(fresh.spawn).not.toHaveBeenCalled();

    const expired = trigger(true, NOW + 2 * HOUR);
    expect(expired.t.maybeSpawn()).toBe("spawned");
  });

  it("does not spawn a second run while one spawned minutes ago may still be running", () => {
    store.update({ lastSpawnAt: NOW - 5 * 60 * 1000 });
    const { t, spawn } = trigger(true);
    expect(t.maybeSpawn()).toBe("in-flight");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("backs off after failures, longer for each consecutive one", () => {
    store.update({ lastFailureAt: NOW - 30 * 60 * 1000, consecutiveFailures: 1 });
    expect(trigger(true).t.maybeSpawn()).toBe("backoff");
    expect(trigger(true, NOW + 31 * 60 * 1000).t.maybeSpawn()).toBe("spawned");

    store.update({ lastSpawnAt: undefined, lastFailureAt: NOW - 90 * 60 * 1000, consecutiveFailures: 2 });
    expect(trigger(true).t.maybeSpawn()).toBe("backoff");
  });

  it("swallows a throwing spawn and a corrupt state file", () => {
    writeFileSync(join(dataDir, "client-update-state.json"), "{broken");
    const t = new ClientUpdateTrigger({
      setting: () => ({ enabled: true, source: "default" }),
      store,
      spawn: () => {
        throw new Error("EAGAIN");
      },
      clock: () => NOW,
    });
    expect(() => t.maybeSpawn()).not.toThrow();
  });

  it("serves the manual-update hint a background run left, only while the setting is on", () => {
    store.update({ manualUpdateHint: "run `tea-rags update` by hand" });
    expect(trigger(true).t.manualUpdateHint()).toBe("run `tea-rags update` by hand");
    expect(trigger(false).t.manualUpdateHint()).toBeNull();
  });
});
