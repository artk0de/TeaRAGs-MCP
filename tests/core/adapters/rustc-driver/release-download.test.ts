import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  defaultRustcCallSiteRunnerDeps,
  rustcDriverCrateDir,
} from "../../../../src/core/adapters/rustc-driver/callsite-runner.js";
import {
  computeRustcDriverSourceHash,
  defaultRustcDriverSourceFs,
} from "../../../../src/core/adapters/rustc-driver/driver-build.js";
import { discoverRustcDriver } from "../../../../src/core/adapters/rustc-driver/executable.js";
import { RUSTC_DRIVER_TOOLCHAIN_PIN } from "../../../../src/core/adapters/rustc-driver/pin.js";
import {
  downloadRustcDriverRelease,
  installRustcDriverToolchain,
  managedRustToolchainEnv,
  rustcDriverReleaseAssetPlatform,
  type RustcDriverReleaseManifest,
} from "../../../../src/core/adapters/rustc-driver/release-download.js";

const execFileAsync = promisify(execFile);
const run = async (cmd: string, args: string[]): Promise<void> => {
  await execFileAsync(cmd, args);
};

const SOURCE_HASH = computeRustcDriverSourceHash(rustcDriverCrateDir(), defaultRustcDriverSourceFs);
const ASSET = `tea-rags-rustc-driver-${RUSTC_DRIVER_TOOLCHAIN_PIN}-${SOURCE_HASH}-linux-x64.tar.gz`;

function fakeFetch(routes: Record<string, Buffer | string>): (input: string) => Promise<Response> {
  return async (input: string) => {
    const body = routes[input];
    if (body === undefined) return new Response("missing", { status: 404 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  };
}

describe("rustcDriverReleaseAssetPlatform", () => {
  it("maps the five release platforms and nothing else", () => {
    expect(rustcDriverReleaseAssetPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(rustcDriverReleaseAssetPlatform("darwin", "x64")).toBe("darwin-x64");
    expect(rustcDriverReleaseAssetPlatform("linux", "x64")).toBe("linux-x64");
    expect(rustcDriverReleaseAssetPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(rustcDriverReleaseAssetPlatform("win32", "x64")).toBe("windows-x64");
    expect(rustcDriverReleaseAssetPlatform("win32", "arm64")).toBeUndefined();
    expect(rustcDriverReleaseAssetPlatform("freebsd", "x64")).toBeUndefined();
  });
});

describe("downloadRustcDriverRelease", () => {
  let dir: string;
  let dataDir: string;
  let archive: Buffer;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rustc-driver-release-"));
    dataDir = join(dir, "data");
    const content = join(dir, "content");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "tea-rags-rustc-driver"), "driver bytes");
    writeFileSync(join(content, "tea-rags-rustc-driver-wrapper"), "wrapper bytes");
    const archivePath = join(dir, ASSET);
    execFileSync("tar", ["-czf", archivePath, "-C", content, "tea-rags-rustc-driver", "tea-rags-rustc-driver-wrapper"]);
    archive = readFileSync(archivePath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const base = "https://github.com/artk0de/TeaRAGs-MCP/releases/download/v1.2.3";

  function manifest(overrides: Partial<RustcDriverReleaseManifest> = {}): string {
    const body: RustcDriverReleaseManifest = {
      pin: RUSTC_DRIVER_TOOLCHAIN_PIN,
      sourceHash: SOURCE_HASH,
      assets: { "linux-x64": { asset: ASSET, sha256: createHash("sha256").update(archive).digest("hex") } },
      ...overrides,
    };
    return JSON.stringify(body);
  }

  it("throws on a manifest whose pin differs, naming both pins", async () => {
    const fetch = fakeFetch({ [`${base}/rustc-driver-manifest.json`]: manifest({ pin: "nightly-2020-01-01" }) });

    await expect(
      downloadRustcDriverRelease({ version: "1.2.3", dataDir, platform: "linux", arch: "x64" }, { fetch, run }),
    ).rejects.toThrow(new RegExp(`nightly-2020-01-01[\\s\\S]*${RUSTC_DRIVER_TOOLCHAIN_PIN}`));
    expect(existsSync(join(dataDir, "rustc-driver", "bin"))).toBe(false);
  });

  it("throws on a manifest whose sourceHash differs (stale release)", async () => {
    const fetch = fakeFetch({ [`${base}/rustc-driver-manifest.json`]: manifest({ sourceHash: "0".repeat(64) }) });

    await expect(
      downloadRustcDriverRelease({ version: "1.2.3", dataDir, platform: "linux", arch: "x64" }, { fetch, run }),
    ).rejects.toThrow(/stale/i);
  });

  it("publishes a matching release into the buildPaths binDir that discovery reads as tier cache", async () => {
    const fetch = fakeFetch({
      [`${base}/rustc-driver-manifest.json`]: manifest(),
      [`${base}/${ASSET}`]: archive,
    });

    const binary = await downloadRustcDriverRelease(
      { version: "1.2.3", dataDir, platform: "linux", arch: "x64" },
      { fetch, run },
    );

    const binDir = join(dataDir, "rustc-driver", "bin", `${RUSTC_DRIVER_TOOLCHAIN_PIN}-${SOURCE_HASH}`);
    expect(binary).toBe(join(binDir, "tea-rags-rustc-driver"));
    expect(readFileSync(join(binDir, "tea-rags-rustc-driver-wrapper"), "utf-8")).toBe("wrapper bytes");

    const discovery = discoverRustcDriver({
      pin: RUSTC_DRIVER_TOOLCHAIN_PIN,
      sourceHash: SOURCE_HASH,
      env: { PATH: "" },
      homeDir: dir,
      dataDir,
      run: (command) =>
        command === binary
          ? { kind: "ok", stdout: `tea-rags-rustc-driver 0.1.0 ${RUSTC_DRIVER_TOOLCHAIN_PIN} ${SOURCE_HASH}` }
          : { kind: "failed" },
      fs: { exists: (path) => existsSync(path), listDir: () => [] },
    });
    expect(discovery).toMatchObject({ kind: "binary", tier: "cache", path: binary });
  });

  it("removes the downloaded archive when it verifies but lacks a binary, so the next run re-downloads", async () => {
    const partial = join(dir, "partial");
    mkdirSync(partial, { recursive: true });
    writeFileSync(join(partial, "tea-rags-rustc-driver"), "driver bytes");
    const partialPath = join(dir, `partial-${ASSET}`);
    execFileSync("tar", ["-czf", partialPath, "-C", partial, "tea-rags-rustc-driver"]);
    const incomplete = readFileSync(partialPath);
    const body: RustcDriverReleaseManifest = {
      pin: RUSTC_DRIVER_TOOLCHAIN_PIN,
      sourceHash: SOURCE_HASH,
      assets: { "linux-x64": { asset: ASSET, sha256: createHash("sha256").update(incomplete).digest("hex") } },
    };
    const fetch = fakeFetch({
      [`${base}/rustc-driver-manifest.json`]: JSON.stringify(body),
      [`${base}/${ASSET}`]: incomplete,
    });

    await expect(
      downloadRustcDriverRelease({ version: "1.2.3", dataDir, platform: "linux", arch: "x64" }, { fetch, run }),
    ).rejects.toThrow(/lacks/);
    expect(existsSync(join(dataDir, "rustc-driver", "downloads", ASSET))).toBe(false);
  });

  it("refuses a platform the release does not build", async () => {
    await expect(
      downloadRustcDriverRelease(
        { version: "1.2.3", dataDir, platform: "win32", arch: "arm64" },
        { fetch: fakeFetch({}), run },
      ),
    ).rejects.toThrow(/win32-arm64/);
  });
});

describe("installRustcDriverToolchain", () => {
  it("installs the pin with --profile minimal under the managed RUSTUP_HOME/CARGO_HOME", async () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
    await installRustcDriverToolchain(
      { pin: "nightly-2026-05-01", dataDir: "/data" },
      {
        run: async (cmd, args, env) => {
          calls.push({ cmd, args, env });
        },
        exists: () => true,
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe(
      join("/data", "rust", "cargo", "bin", process.platform === "win32" ? "rustup.exe" : "rustup"),
    );
    expect(calls[0].args).toEqual(["toolchain", "install", "nightly-2026-05-01", "--profile", "minimal"]);
    expect(calls[0].env).toMatchObject({
      RUSTUP_HOME: join("/data", "rust", "rustup"),
      CARGO_HOME: join("/data", "rust", "cargo"),
    });
  });

  it("bootstraps rustup into the managed home with --no-modify-path when it is missing", async () => {
    const calls: { cmd: string; args: string[]; env: Record<string, string> }[] = [];
    await installRustcDriverToolchain(
      { pin: "nightly-2026-05-01", dataDir: "/data" },
      {
        run: async (cmd, args, env) => {
          calls.push({ cmd, args, env });
        },
        exists: () => false,
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].args.join(" ")).toContain("--no-modify-path");
    expect(calls[0].env).toMatchObject({
      RUSTUP_HOME: join("/data", "rust", "rustup"),
      CARGO_HOME: join("/data", "rust", "cargo"),
    });
    expect(calls[1].args).toEqual(["toolchain", "install", "nightly-2026-05-01", "--profile", "minimal"]);
  });
});

describe("managedRustToolchainEnv", () => {
  it("leaves the env untouched when no managed toolchain dir exists", () => {
    const base = { PATH: "/usr/bin" };
    expect(managedRustToolchainEnv(base, "/data", { platform: "linux", arch: "x64", exists: () => false })).toEqual(
      base,
    );
  });

  it("points rustup, cargo and the loader at the managed toolchain", () => {
    const env = managedRustToolchainEnv({ PATH: "/usr/bin" }, "/data", {
      platform: "linux",
      arch: "x64",
      exists: () => true,
    });
    expect(env.RUSTUP_HOME).toBe(join("/data", "rust", "rustup"));
    expect(env.CARGO_HOME).toBe(join("/data", "rust", "cargo"));
    expect(env.PATH?.startsWith(join("/data", "rust", "cargo", "bin"))).toBe(true);
    expect(env.LD_LIBRARY_PATH).toBe(
      join("/data", "rust", "rustup", "toolchains", `${RUSTC_DRIVER_TOOLCHAIN_PIN}-x86_64-unknown-linux-gnu`, "lib"),
    );
  });
});

describe("defaultRustcCallSiteRunnerDeps with a managed toolchain", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("runs the driver with RUSTUP_HOME under the data dir when its rust/ dir exists", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rustc-driver-managed-"));
    dirs.push(dataDir);
    mkdirSync(join(dataDir, "rust"));

    const deps = defaultRustcCallSiteRunnerDeps({ TEA_RAGS_DATA_DIR: dataDir, PATH: "/usr/bin" });

    expect(deps.env.RUSTUP_HOME).toBe(join(dataDir, "rust", "rustup"));
    expect(deps.env.CARGO_HOME).toBe(join(dataDir, "rust", "cargo"));
  });

  it("keeps the caller's env when the data dir has no managed toolchain", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rustc-driver-unmanaged-"));
    dirs.push(dataDir);

    const deps = defaultRustcCallSiteRunnerDeps({ TEA_RAGS_DATA_DIR: dataDir, PATH: "/usr/bin" });

    expect(deps.env.RUSTUP_HOME).toBeUndefined();
  });
});
