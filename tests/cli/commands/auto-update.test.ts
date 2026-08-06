import { describe, expect, it, vi } from "vitest";

import { runAutoUpdateCliCommand, type AutoUpdateCliDeps } from "../../../src/cli/commands/auto-update.js";
import type { CollectionEntry } from "../../../src/core/api/public/index.js";

const entry: CollectionEntry = {
  collectionName: "code_x",
  path: "/repo/x",
  name: "proj",
  embeddingModel: "m",
  embeddingDimensions: 384,
  qdrantUrl: "http://localhost:6333",
  indexedAt: "2026-08-06T00:00:00.000Z",
  teaRagsVersion: "1.0.0",
  chunksCount: 10,
};

function deps(over: Partial<AutoUpdateCliDeps> = {}) {
  const out: string[] = [];
  const errOut: string[] = [];
  const exit = vi.fn();
  const setAutoUpdate = vi.fn();
  const base: AutoUpdateCliDeps = {
    registry: {
      findByName: (name: string) => (name === "proj" ? entry : null),
      get: (cn: string) => (cn === "code_x" ? entry : null),
      setAutoUpdate,
    } as AutoUpdateCliDeps["registry"],
    freshness: { check: () => ({ kind: "eligible", entry }) },
    detectBranch: () => "main",
    logPathFor: (label: string) => `/data/logs/auto-update-${label}.log`,
    executeUpdater: async () => 0,
    out: (line: string) => out.push(line),
    errOut: (line: string) => errOut.push(line),
    exit,
    ...over,
  };
  return { base, out, errOut, exit, setAutoUpdate };
}

describe("runAutoUpdateCliCommand", () => {
  it("enable autodetects the default branch and writes the config", async () => {
    const d = deps();
    await runAutoUpdateCliCommand("enable", { project: "proj" }, d.base);
    expect(d.setAutoUpdate).toHaveBeenCalledWith("code_x", { enabled: true, targetBranch: "main" });
    expect(d.out.join("\n")).toContain("main");
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("enable honors --branch over autodetect", async () => {
    const d = deps();
    await runAutoUpdateCliCommand("enable", { project: "proj", branch: "trunk" }, d.base);
    expect(d.setAutoUpdate).toHaveBeenCalledWith("code_x", { enabled: true, targetBranch: "trunk" });
  });

  it("enable preserves an existing lastRun through re-enable", async () => {
    const lastRun = { at: "2026-08-06T10:00:00Z", outcome: "ok" as const, durationMs: 5, filesChanged: 1 };
    const withRun = { ...entry, autoUpdate: { enabled: false, targetBranch: "main", lastRun } };
    const d = deps({
      registry: {
        findByName: () => withRun,
        get: () => withRun,
        setAutoUpdate: vi.fn(),
      } as AutoUpdateCliDeps["registry"],
    });
    await runAutoUpdateCliCommand("enable", { project: "proj" }, d.base);
    expect(d.base.registry.setAutoUpdate).toHaveBeenCalledWith("code_x", {
      enabled: true,
      targetBranch: "main",
      lastRun,
    });
  });

  it("disable preserves targetBranch so re-enable remembers it", async () => {
    const configured = { ...entry, autoUpdate: { enabled: true, targetBranch: "trunk" } };
    const setAutoUpdate = vi.fn();
    const d = deps({
      registry: {
        findByName: () => configured,
        get: () => configured,
        setAutoUpdate,
      } as AutoUpdateCliDeps["registry"],
    });
    await runAutoUpdateCliCommand("disable", { project: "proj" }, d.base);
    expect(setAutoUpdate).toHaveBeenCalledWith("code_x", { enabled: false, targetBranch: "trunk" });
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("disable without a config block is a friendly no-op", async () => {
    const d = deps();
    await runAutoUpdateCliCommand("disable", { project: "proj" }, d.base);
    expect(d.setAutoUpdate).not.toHaveBeenCalled();
    expect(d.out.join("\n")).toMatch(/not configured/i);
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("status prints config, verdict, lastRun and the log path", async () => {
    const configured = {
      ...entry,
      autoUpdate: {
        enabled: true,
        targetBranch: "main",
        lastRun: { at: "2026-08-06T10:00:00Z", outcome: "ok" as const, durationMs: 1200, filesChanged: 3 },
      },
    };
    const d = deps({
      registry: {
        findByName: () => configured,
        get: () => configured,
        setAutoUpdate: vi.fn(),
      } as AutoUpdateCliDeps["registry"],
      freshness: { check: () => ({ kind: "branch-mismatch", head: "feature-x", targetBranch: "main" }) },
    });
    await runAutoUpdateCliCommand("status", { project: "proj" }, d.base);
    const text = d.out.join("\n");
    expect(text).toContain("enabled (main)");
    expect(text).toContain("branch-mismatch");
    expect(text).toContain("ok");
    expect(text).toContain("/data/logs/auto-update-proj.log");
    expect(d.exit).toHaveBeenCalledWith(0);
  });

  it("run resolves by collectionName too and exits with the updater code", async () => {
    const executeUpdater = vi.fn(async () => 3);
    const d = deps({ executeUpdater });
    await runAutoUpdateCliCommand("run", { project: "code_x" }, d.base);
    expect(executeUpdater).toHaveBeenCalledWith("code_x");
    expect(d.exit).toHaveBeenCalledWith(3);
  });

  it("unknown project exits 1 with a projects hint", async () => {
    const d = deps();
    await runAutoUpdateCliCommand("status", { project: "nope" }, d.base);
    expect(d.errOut.join("\n")).toContain("tea-rags projects");
    expect(d.exit).toHaveBeenCalledWith(1);
  });
});
