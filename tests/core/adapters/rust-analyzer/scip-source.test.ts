/**
 * The host-bound `RustAnalyzerScipSource` (bd s3i8m.6 R2b): the slot switch,
 * discovery, the working-tree build's cache-only mode, and the outcome →
 * acquisition mapping. The runner itself is covered by scip-runner.test.ts.
 */
import { describe, expect, it } from "vitest";

import {
  createRustAnalyzerScipSource,
  type RustAnalyzerExecutable,
  type RustAnalyzerScipRunnerDeps,
  type RustAnalyzerScipRunOptions,
  type RustAnalyzerScipRunOutcome,
  type RustAnalyzerScipSourceDeps,
} from "../../../../src/core/adapters/rust-analyzer/index.js";
import type { RustAnalyzerScipSourceConfig } from "../../../../src/core/contracts/types/language.js";

const RA: RustAnalyzerExecutable = {
  path: "/bin/ra",
  tier: "path",
  version: "0.3.2000",
  commit: "abc",
  date: "2026-01-01",
};

const CONFIG: RustAnalyzerScipSourceConfig = {
  enabled: true,
  exec: false,
  timeoutSec: 900,
  maxRssMb: 4096,
  spawn: "allowed",
};

function fakeDeps(
  outcome: RustAnalyzerScipRunOutcome,
  executable: RustAnalyzerExecutable | null = RA,
): { deps: RustAnalyzerScipSourceDeps; runs: RustAnalyzerScipRunOptions[]; discovered: string[] } {
  const runs: RustAnalyzerScipRunOptions[] = [];
  const discovered: string[] = [];
  return {
    runs,
    discovered,
    deps: {
      discover: (projectRoot) => {
        discovered.push(projectRoot);
        return executable;
      },
      run: async (options) => {
        runs.push(options);
        return outcome;
      },
      runnerDeps: () => ({}) as RustAnalyzerScipRunnerDeps,
    },
  };
}

const index = { identity: "env:content", definitionAt: () => null };

describe("createRustAnalyzerScipSource (bd s3i8m.6 R2b)", () => {
  it("skips as disabled without discovering or running when the slot is off", async () => {
    const { deps, runs, discovered } = fakeDeps({ kind: "indexed", index, cacheHit: true, toolchainSkew: false });
    const source = createRustAnalyzerScipSource({ ...CONFIG, enabled: false }, deps);

    expect(await source.acquire({ projectRoot: "/p", admission: () => "spawn" })).toEqual({
      kind: "skipped",
      reason: "disabled",
    });
    expect(discovered).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("skips as noBinary without running when discovery finds nothing", async () => {
    const { deps, runs } = fakeDeps({ kind: "indexed", index, cacheHit: true, toolchainSkew: false }, null);
    const source = createRustAnalyzerScipSource(CONFIG, deps);

    expect(await source.acquire({ projectRoot: "/p", admission: () => "spawn" })).toEqual({
      kind: "skipped",
      reason: "noBinary",
    });
    expect(runs).toEqual([]);
  });

  it("runs with the config's budgets and the caller's admission, mapping spawn stats", async () => {
    const { deps, runs } = fakeDeps({
      kind: "indexed",
      index,
      cacheHit: false,
      toolchainSkew: true,
      stats: { wallMs: 1200, peakRssMb: 900, references: 3, definitions: 2 },
    });
    const admission = (): "spawn" => "spawn";
    const source = createRustAnalyzerScipSource({ ...CONFIG, exec: true, timeoutSec: 60, maxRssMb: 2048 }, deps);

    const acquisition = await source.acquire({ projectRoot: "/p", admission });

    expect(acquisition).toEqual({
      kind: "indexed",
      index,
      cacheHit: false,
      toolchainSkew: true,
      wallMs: 1200,
      peakRssMb: 900,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ projectRoot: "/p", executable: RA, exec: true, timeoutSec: 60, maxRssMb: 2048 });
    expect(runs[0]?.admission).toBe(admission);
  });

  it("never lets a cache-only source spawn, whatever the caller admits", async () => {
    const { deps, runs } = fakeDeps({ kind: "skipped", reason: "noBulkNoCache" });
    const source = createRustAnalyzerScipSource({ ...CONFIG, spawn: "never" }, deps);

    const acquisition = await source.acquire({ projectRoot: "/p", admission: () => "spawn" });

    expect(runs[0]?.admission?.(["src/main.rs"])).toBe("reuseOnly");
    expect(acquisition).toEqual({ kind: "skipped", reason: "noBulkNoCache" });
  });

  it("passes a latch through with its hint", async () => {
    const { deps } = fakeDeps({ kind: "latched", reason: "offline", detail: "net", hint: "cargo fetch" });
    const source = createRustAnalyzerScipSource(CONFIG, deps);

    expect(await source.acquire({ projectRoot: "/p", admission: () => "spawn" })).toEqual({
      kind: "latched",
      reason: "offline",
      detail: "net",
      hint: "cargo fetch",
    });
  });
});
