import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  computeRustCallsitesSourceHash,
  defaultRustcDriverSourceFs,
  ensureRustcDriverBuilt,
  type RustcDriverBuildDeps,
  type RustcDriverBuildFs,
  type RustcDriverSpawnOutcome,
} from "../../../../src/core/adapters/rustc-driver/driver-build.js";

const PIN = "nightly-2026-05-01";
const HASH = "h1";
const SYSROOT = "/tc/nightly-2026-05-01-aarch64-apple-darwin";
const DATA = "/data";
const CRATE = "/pkg/native/rust-callsites";
const BIN_DIR = `${DATA}/rustc-driver/bin/${PIN}-${HASH}`;
const LATCH = `${DATA}/rustc-driver/bin/${PIN}-${HASH}.latch.json`;
const CLI = "tearags-rust-callsites";
const WRAPPER = "tearags-rust-callsites-driver";
const banner = (hash = HASH, pin = PIN): string => `0.1.0 ${pin} ${hash}\n`;

type RunOptions = { env: Record<string, string | undefined>; cwd: string; timeoutMs: number };

interface Scenario {
  cargo?: "ok" | "fail" | "timeout" | "no-binaries";
  banner?: string;
  renameFails?: boolean;
}

function setup(scenario: Scenario = {}) {
  const files = new Map<string, string>();
  const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
  const fs: RustcDriverBuildFs = {
    exists: (p) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    readText: (p) => files.get(p) ?? "",
    writeText: (p, c) => void files.set(p, c),
    mkdirp: () => undefined,
    copyFile: (from, to) => {
      if (!files.has(from)) throw new Error(`ENOENT ${from}`);
      files.set(to, files.get(from) ?? "");
    },
    rename: (from, to) => {
      if (scenario.renameFails) throw new Error("EXDEV");
      for (const [k, v] of [...files]) {
        if (k.startsWith(`${from}/`)) {
          files.delete(k);
          files.set(`${to}${k.slice(from.length)}`, v);
        }
      }
    },
    remove: (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(`${p}/`)) files.delete(k);
    },
  };
  const run = vi.fn(
    async (command: string, args: readonly string[], options: RunOptions): Promise<RustcDriverSpawnOutcome> => {
      calls.push({ command, args, options });
      if (args[0] === "-V") return { kind: "exited", status: 0, output: scenario.banner ?? banner() };
      const mode = scenario.cargo ?? "ok";
      if (mode === "timeout") return { kind: "timed-out", output: "partial" };
      if (mode === "fail") return { kind: "exited", status: 101, output: "error[E0463]" };
      const target = args[args.indexOf("--target-dir") + 1];
      if (mode === "ok") {
        files.set(`${target}/release/${CLI}`, "cli");
        files.set(`${target}/release/${WRAPPER}`, "wrapper");
      }
      return { kind: "exited", status: 0, output: "Finished" };
    },
  );
  const deps: RustcDriverBuildDeps = {
    crateDir: CRATE,
    pin: PIN,
    sourceHash: HASH,
    dataDir: DATA,
    env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/h" },
    run,
    fs,
    now: () => new Date("2026-10-23T00:00:00Z"),
  };
  return { deps, files, calls, run };
}

describe("ensureRustcDriverBuilt", () => {
  it("builds once into <dataDir>/rustc-driver/bin/<pin>-<hash>/ and reuses it afterwards", async () => {
    const { deps, files, run } = setup();
    const first = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(first).toEqual({
      ok: true,
      built: true,
      binDir: BIN_DIR,
      binaryPath: `${BIN_DIR}/${CLI}`,
      wrapperPath: `${BIN_DIR}/${WRAPPER}`,
    });
    expect(files.has(`${BIN_DIR}/${CLI}`)).toBe(true);
    expect(files.has(`${BIN_DIR}/${WRAPPER}`)).toBe(true);
    const spawnsAfterBuild = run.mock.calls.length;

    const second = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(second).toMatchObject({ ok: true, built: false, binDir: BIN_DIR });
    expect(run.mock.calls.length).toBe(spawnsAfterBuild);
  });

  it("forces the pinned toolchain: exact cargo command and env, sysroot bin before Homebrew on PATH", async () => {
    const { deps, calls } = setup();
    await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    const cargo = calls[0];
    expect(cargo.command).toBe(`${SYSROOT}/bin/cargo`);
    expect(cargo.args).toEqual([
      "build",
      "--release",
      "--offline",
      "--manifest-path",
      `${CRATE}/Cargo.toml`,
      "--target-dir",
      `${DATA}/rustc-driver/build-tmp/${PIN}-${HASH}`,
    ]);
    expect(cargo.options.cwd).toBe(CRATE);
    expect(cargo.options.env.RUSTUP_TOOLCHAIN).toBe(PIN);
    expect(cargo.options.env.RUSTC).toBe(`${SYSROOT}/bin/rustc`);
    expect(cargo.options.env.CARGO).toBe(`${SYSROOT}/bin/cargo`);
    expect(cargo.options.env.PATH).toBe(`${SYSROOT}/bin:/opt/homebrew/bin:/usr/bin`);
    expect(cargo.options.env.HOME).toBe("/h");
  });

  it("defaults the build timeout to 600 s and honours an injected one", async () => {
    const a = setup();
    const b = setup();
    await ensureRustcDriverBuilt(a.deps, { sysroot: SYSROOT });
    await ensureRustcDriverBuilt({ ...b.deps, timeoutMs: 42 }, { sysroot: SYSROOT });
    expect(a.calls[0].options.timeoutMs).toBe(600_000);
    expect(b.calls[0].options.timeoutMs).toBe(42);
  });

  it("a failing build returns a typed failure with a log path, latches, and is not retried", async () => {
    const { deps, files, run } = setup({ cargo: "fail" });
    const first = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(first).toEqual({
      ok: false,
      reason: "build-failed",
      detail: expect.stringContaining("101"),
      logPath: `${DATA}/rustc-driver/build-logs/${PIN}-${HASH}.log`,
    });
    expect(files.get(`${DATA}/rustc-driver/build-logs/${PIN}-${HASH}.log`)).toContain("E0463");
    expect(JSON.parse(files.get(LATCH) ?? "{}")).toMatchObject({ pin: PIN, sourceHash: HASH, reason: "build-failed" });
    const spawns = run.mock.calls.length;

    const second = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(second).toMatchObject({ ok: false, reason: "latched" });
    expect(run.mock.calls.length).toBe(spawns);
  });

  it("a new sourceHash is a new latch key and retries the build", async () => {
    const { deps, run } = setup({ cargo: "fail" });
    await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    const spawns = run.mock.calls.length;
    const result = await ensureRustcDriverBuilt({ ...deps, sourceHash: "h2" }, { sysroot: SYSROOT });
    expect(result).toMatchObject({ ok: false, reason: "build-failed" });
    expect(run.mock.calls.length).toBeGreaterThan(spawns);
  });

  it("a new pin is a new latch key and retries the build", async () => {
    const { deps, run } = setup({ cargo: "fail" });
    await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    const spawns = run.mock.calls.length;
    await ensureRustcDriverBuilt({ ...deps, pin: "nightly-2026-06-01" }, { sysroot: SYSROOT });
    expect(run.mock.calls.length).toBeGreaterThan(spawns);
  });

  it("a timeout is a latched typed failure", async () => {
    const { deps, files } = setup({ cargo: "timeout" });
    const result = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(result).toMatchObject({ ok: false, reason: "timed-out" });
    expect(files.has(LATCH)).toBe(true);
  });

  it("a build that produces no binaries is binary-missing and latched", async () => {
    const { deps, files } = setup({ cargo: "no-binaries" });
    const result = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(result).toMatchObject({ ok: false, reason: "binary-missing" });
    expect(files.has(LATCH)).toBe(true);
  });

  it("a banner whose sourceHash differs from the expected one fails, latches, and publishes nothing", async () => {
    const { deps, files } = setup({ banner: banner("other") });
    const result = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(result).toMatchObject({ ok: false, reason: "banner-mismatch" });
    expect(files.has(LATCH)).toBe(true);
    expect([...files.keys()].filter((k) => k.startsWith(`${BIN_DIR}/`))).toEqual([]);
  });

  it("a banner pin mismatch fails the same way", async () => {
    const { deps } = setup({ banner: banner(HASH, "nightly-2020-01-01") });
    expect(await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT })).toMatchObject({ reason: "banner-mismatch" });
  });

  it("is atomic: a failed publish leaves no binary under the final directory and no staging residue", async () => {
    const { deps, files } = setup({ renameFails: true });
    const result = await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    expect(result).toMatchObject({ ok: false, reason: "install-failed" });
    const residue = [...files.keys()].filter((k) => k.startsWith(`${DATA}/rustc-driver/bin/`) && k !== LATCH);
    expect(residue).toEqual([]);
    expect([...files.keys()].some((k) => k.includes("build-tmp"))).toBe(false);
  });

  it("verifies the STAGED binary before it is published", async () => {
    const { deps, calls } = setup();
    await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT });
    const verify = calls.find((c) => c.args[0] === "-V");
    expect(verify?.command).toBe(`${BIN_DIR}.staging/${CLI}`);
  });

  it("a corrupt latch file is ignored", async () => {
    const { deps, files } = setup();
    files.set(LATCH, "{not json");
    expect(await ensureRustcDriverBuilt(deps, { sysroot: SYSROOT })).toMatchObject({ ok: true, built: true });
  });
});

describe("computeRustCallsitesSourceHash", () => {
  it("reproduces the hash the driver binary printed in its -V banner for this crate source", () => {
    const crate = join(dirname(fileURLToPath(import.meta.url)), "../../../../native/rust-callsites");
    // Computed by the crate's own Rust `source_hash` (build_support/source_hash.rs). Editing the
    // crate changes it: refresh from a fresh build's `-V` or by running that Rust function.
    expect(computeRustCallsitesSourceHash(crate, defaultRustcDriverSourceFs)).toBe(
      "43e75f57a48f0345cb29bd495a4f018d89deb2b2d5574b460d98a8dd7f06380d",
    );
  });

  it("follows the Rust definition on a tiny fixture: sorted bytewise, path NUL length NUL bytes", () => {
    const tree: Record<string, string> = {
      "/c/Cargo.toml": "a",
      "/c/Cargo.lock": "bb",
      "/c/build.rs": "",
      "/c/rust-toolchain.toml": "t",
      "/c/build_support/x.rs": "x",
      "/c/src/z.rs": "z",
      "/c/src/a/m.rs": "m",
    };
    const dirs: Record<string, string[]> = {
      "/c/build_support": ["x.rs"],
      "/c/src": ["z.rs", "a"],
      "/c/src/a": ["m.rs"],
    };
    const fs = {
      readFile: (p: string) => Buffer.from(tree[p]),
      listDir: (p: string) =>
        dirs[p].map((name) => ({ name, isDirectory: `${p}/${name}` in dirs, isFile: `${p}/${name}` in tree })),
    };
    const sorted: [string, string][] = [
      ["Cargo.lock", "bb"],
      ["Cargo.toml", "a"],
      ["build.rs", ""],
      ["build_support/x.rs", "x"],
      ["rust-toolchain.toml", "t"],
      ["src/a/m.rs", "m"],
      ["src/z.rs", "z"],
    ];
    const expected = createHash("sha256")
      .update(sorted.map(([p, c]) => `${p}\0${c.length}\0${c}`).join(""))
      .digest("hex");
    expect(computeRustCallsitesSourceHash("/c", fs)).toBe(expected);
  });
});
