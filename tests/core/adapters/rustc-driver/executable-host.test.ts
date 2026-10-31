import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultRustcDriverDiscoveryDeps,
  runRustcDriverHostCommand,
} from "../../../../src/core/adapters/rustc-driver/executable.js";

describe("runRustcDriverHostCommand", () => {
  it("returns stdout of a command that exits 0", () => {
    expect(runRustcDriverHostCommand(process.execPath, ["-e", "process.stdout.write('hello')"], 20_000)).toEqual({
      kind: "ok",
      stdout: "hello",
    });
  });

  it("reports a non-zero exit as failed", () => {
    expect(runRustcDriverHostCommand(process.execPath, ["-e", "process.exit(2)"], 20_000)).toEqual({
      kind: "failed",
    });
  });

  it("reports a missing executable as failed, never a throw", () => {
    expect(runRustcDriverHostCommand("/nonexistent-tea-rags-toolchain", [], 1000)).toEqual({ kind: "failed" });
  });

  it("reports a command that outlives its timeout as timed-out", () => {
    expect(runRustcDriverHostCommand(process.execPath, ["-e", "setTimeout(() => undefined, 30000)"], 200)).toEqual({
      kind: "timed-out",
    });
  });
});

describe("defaultRustcDriverDiscoveryDeps", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("binds the pin, hash and env, takes the data dir from TEA_RAGS_DATA_DIR and probes the real fs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tea-rags-driver-deps-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "sub"));
    writeFileSync(join(dataDir, "present.txt"), "");

    const deps = defaultRustcDriverDiscoveryDeps("nightly-test", "hash123", { TEA_RAGS_DATA_DIR: dataDir });

    expect(deps.pin).toBe("nightly-test");
    expect(deps.sourceHash).toBe("hash123");
    expect(deps.dataDir).toBe(dataDir);
    expect(deps.run).toBe(runRustcDriverHostCommand);
    expect(deps.fs.exists(join(dataDir, "present.txt"))).toBe(true);
    expect(deps.fs.exists(join(dataDir, "absent.txt"))).toBe(false);
    expect([...deps.fs.listDir(dataDir)].sort()).toEqual(["present.txt", "sub"]);
    expect(deps.fs.listDir(join(dataDir, "missing"))).toEqual([]);
  });

  it("falls back to ~/.tea-rags when TEA_RAGS_DATA_DIR is unset", () => {
    const deps = defaultRustcDriverDiscoveryDeps("nightly-test", "hash123", {});
    expect(deps.dataDir.endsWith(".tea-rags")).toBe(true);
  });
});
