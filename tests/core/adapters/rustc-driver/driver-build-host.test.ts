import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeRustcDriverSourceHash,
  defaultRustcDriverBuildFs,
  defaultRustcDriverSourceFs,
  runRustcDriverBuildCommand,
} from "../../../../src/core/adapters/rustc-driver/driver-build.js";

describe("rustc driver build host bindings", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rustc-driver-host-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("stages, publishes and removes a build directory through the real filesystem", () => {
    const fs = defaultRustcDriverBuildFs;
    const staging = join(root, "a", "staging");
    const published = join(root, "a", "bin");
    fs.mkdirp(staging);
    fs.writeText(join(staging, "src.txt"), "driver");
    fs.copyFile(join(staging, "src.txt"), join(staging, "copy.txt"));
    expect(fs.exists(join(staging, "copy.txt"))).toBe(true);
    expect(fs.readText(join(staging, "copy.txt"))).toBe("driver");

    fs.rename(staging, published);
    expect(fs.exists(staging)).toBe(false);
    expect(readFileSync(join(published, "copy.txt"), "utf8")).toBe("driver");

    fs.remove(published);
    fs.remove(published);
    expect(fs.exists(published)).toBe(false);
  });

  it("hashes a crate by walking nested source directories deterministically", () => {
    const fs = defaultRustcDriverBuildFs;
    for (const name of ["Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain.toml"]) {
      fs.writeText(join(root, name), name);
    }
    fs.mkdirp(join(root, "src", "nested"));
    fs.mkdirp(join(root, "build_support"));
    fs.writeText(join(root, "src", "main.rs"), "fn main() {}");
    fs.writeText(join(root, "src", "nested", "mod.rs"), "pub mod x;");
    fs.writeText(join(root, "build_support", "gen.rs"), "gen");

    const first = computeRustcDriverSourceHash(root, defaultRustcDriverSourceFs);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRustcDriverSourceHash(root, defaultRustcDriverSourceFs)).toBe(first);

    fs.writeText(join(root, "src", "nested", "mod.rs"), "pub mod y;");
    expect(computeRustcDriverSourceHash(root, defaultRustcDriverSourceFs)).not.toBe(first);
  });

  it("reports exit status with merged stdout and stderr, and never rejects", async () => {
    const ok = await runRustcDriverBuildCommand(
      process.execPath,
      ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
      { env: process.env, cwd: root, timeoutMs: 20_000 },
    );
    expect(ok.kind).toBe("exited");
    if (ok.kind === "exited") {
      expect(ok.status).toBe(3);
      expect(ok.output).toContain("out");
      expect(ok.output).toContain("err");
    }

    const missing = await runRustcDriverBuildCommand(join(root, "no-such-binary"), [], {
      env: process.env,
      cwd: root,
      timeoutMs: 20_000,
    });
    expect(missing.kind).toBe("spawn-failed");

    const badCwd = await runRustcDriverBuildCommand(process.execPath, ["-v"], {
      env: process.env,
      cwd: join(root, "no-such-dir"),
      timeoutMs: 20_000,
    });
    expect(badCwd.kind).toBe("spawn-failed");
  });

  it("kills a build that outlives its timeout", async () => {
    const outcome = await runRustcDriverBuildCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: process.env,
      cwd: root,
      timeoutMs: 300,
    });
    expect(outcome.kind).toBe("timed-out");
  });
});
