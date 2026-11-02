import { describe, expect, it, vi } from "vitest";

import {
  discoverRustcDriver,
  rustcDriverInstallHint,
  type RustcDriverCommandOutcome,
  type RustcDriverDiscoveryDeps,
} from "../../../../src/core/adapters/rustc-driver/executable.js";

const HOME = "/home/u";
const PIN = "nightly-2026-05-01";
const HASH = "abc123";
const HOST = "aarch64-apple-darwin";
const BIN = "tea-rags-rustc-driver";
const banner = (pin = PIN) => `${BIN} 0.1.0 ${pin} ${HASH}\n`;
const ok = (stdout: string): RustcDriverCommandOutcome => ({ kind: "ok", stdout });

interface FakeHost {
  /** Binary → `-V` outcome. Absent binaries fail. */
  versions?: Record<string, RustcDriverCommandOutcome>;
  existing?: string[];
  dirs?: Record<string, string[]>;
  rustupWhich?: string;
  env?: Record<string, string | undefined>;
}

function sysrootLibs(sysroot: string, host = HOST): Record<string, string[]> {
  return {
    [`${sysroot}/lib/rustlib`]: [host],
    [`${sysroot}/lib/rustlib/${host}/lib`]: ["librustc_driver-1a2b.dylib", "librustc_middle-9f.rlib"],
  };
}

function deps(host: FakeHost): RustcDriverDiscoveryDeps & { run: ReturnType<typeof vi.fn> } {
  const existing = new Set(host.existing ?? []);
  const run = vi.fn((command: string): RustcDriverCommandOutcome => {
    if (command === "rustup") {
      return host.rustupWhich ? ok(`${host.rustupWhich}\n`) : { kind: "failed" };
    }
    return host.versions?.[command] ?? { kind: "failed" };
  });
  return {
    pin: PIN,
    sourceHash: HASH,
    env: { PATH: "/usr/bin:/opt/bin", ...host.env },
    homeDir: HOME,
    dataDir: `${HOME}/.tea-rags`,
    run,
    fs: {
      exists: (p) => existing.has(p),
      listDir: (p) => host.dirs?.[p] ?? [],
    },
  };
}

describe("discoverRustcDriver", () => {
  it("accepts CODEGRAPH_RUST_DRIVER_PATH when the probe pin matches", () => {
    const d = deps({ env: { CODEGRAPH_RUST_DRIVER_PATH: "/x/drv" }, versions: { "/x/drv": ok(banner()) } });
    expect(discoverRustcDriver(d)).toEqual({
      kind: "binary",
      tier: "env",
      path: "/x/drv",
      version: "0.1.0",
      pin: PIN,
      sourceHash: HASH,
    });
    expect(d.run).toHaveBeenCalledWith("/x/drv", ["-V"], expect.any(Number));
  });

  it("rejects a pin mismatch and falls through to PATH", () => {
    const d = deps({
      env: { CODEGRAPH_RUST_DRIVER_PATH: "/x/drv" },
      versions: { "/x/drv": ok(banner("nightly-2020-01-01")), [`/opt/bin/${BIN}`]: ok(banner()) },
      existing: [`/opt/bin/${BIN}`],
    });
    expect(discoverRustcDriver(d)).toMatchObject({ kind: "binary", tier: "path", path: `/opt/bin/${BIN}` });
  });

  it("rejects an unparseable banner", () => {
    const d = deps({ env: { CODEGRAPH_RUST_DRIVER_PATH: "/x/drv" }, versions: { "/x/drv": ok("garbage") } });
    expect(discoverRustcDriver(d)).toBeNull();
  });

  it("finds the data-dir build cache keyed by pin and sourceHash", () => {
    const cached = `${HOME}/.tea-rags/rustc-driver/bin/${PIN}-${HASH}/${BIN}`;
    const d = deps({ versions: { [cached]: ok(banner()) }, existing: [cached] });
    expect(discoverRustcDriver(d)).toMatchObject({ kind: "binary", tier: "cache", path: cached });
  });

  it("uses the injected dataDir for the cache", () => {
    const cached = `/data/rustc-driver/bin/${PIN}-${HASH}/${BIN}`;
    const d = { ...deps({ versions: { [cached]: ok(banner()) }, existing: [cached] }), dataDir: "/data" };
    expect(discoverRustcDriver(d)).toMatchObject({ tier: "cache", path: cached });
  });

  it("reports buildable via rustup which when rustc-dev is present", () => {
    const sysroot = "/r/toolchains/nightly-2026-05-01-aarch64-apple-darwin";
    const d = deps({ rustupWhich: `${sysroot}/bin/rustc`, dirs: sysrootLibs(sysroot) });
    expect(discoverRustcDriver(d)).toEqual({ kind: "buildable", tier: "rustup", sysroot, host: HOST });
  });

  it("is not buildable when rustc-dev is missing", () => {
    const sysroot = "/r/toolchains/nightly-2026-05-01-aarch64-apple-darwin";
    const d = deps({
      rustupWhich: `${sysroot}/bin/rustc`,
      dirs: {
        [`${sysroot}/lib/rustlib`]: [HOST],
        [`${sysroot}/lib/rustlib/${HOST}/lib`]: ["libstd-1.rlib"],
      },
    });
    expect(discoverRustcDriver(d)).toBeNull();
  });

  it("requires both librustc_driver and the rustc_middle rlib", () => {
    const sysroot = "/r/toolchains/nightly-2026-05-01-aarch64-apple-darwin";
    const d = deps({
      rustupWhich: `${sysroot}/bin/rustc`,
      dirs: {
        [`${sysroot}/lib/rustlib`]: [HOST],
        [`${sysroot}/lib/rustlib/${HOST}/lib`]: ["librustc_driver-1.dylib"],
      },
    });
    expect(discoverRustcDriver(d)).toBeNull();
  });

  it("accepts rustc-dev shipping rustc_middle as an rmeta only (nightly-2026-05-01 layout)", () => {
    const sysroot = "/r/toolchains/nightly-2026-05-01-aarch64-apple-darwin";
    const d = deps({
      rustupWhich: `${sysroot}/bin/rustc`,
      dirs: {
        [`${sysroot}/lib/rustlib`]: [HOST],
        [`${sysroot}/lib/rustlib/${HOST}/lib`]: ["librustc_driver-1.dylib", "librustc_middle-58d2.rmeta"],
      },
    });
    expect(discoverRustcDriver(d)).toMatchObject({ kind: "buildable", sysroot, host: HOST });
  });

  it("falls back to the RUSTUP_HOME toolchains dir", () => {
    const tc = "/rh/toolchains";
    const sysroot = `${tc}/${PIN}-${HOST}`;
    const d = deps({
      env: { RUSTUP_HOME: "/rh" },
      dirs: { [tc]: ["stable-x86_64-unknown-linux-gnu", `${PIN}-${HOST}`], ...sysrootLibs(sysroot) },
    });
    expect(discoverRustcDriver(d)).toMatchObject({ kind: "buildable", tier: "rustup", sysroot, host: HOST });
  });

  it("falls back to asdf rust installs", () => {
    const installs = `${HOME}/.asdf/installs/rust`;
    const sysroot = `${installs}/1.80.0/toolchains/${PIN}-${HOST}`;
    const d = deps({
      dirs: {
        [installs]: ["1.80.0"],
        [`${installs}/1.80.0/toolchains`]: [`${PIN}-${HOST}`],
        ...sysrootLibs(sysroot),
      },
    });
    expect(discoverRustcDriver(d)).toMatchObject({ kind: "buildable", tier: "asdf", sysroot });
  });

  it("returns null on a Homebrew-only host", () => {
    const d = deps({ dirs: { "/opt/homebrew/Cellar/rust": ["1.90.0"] } });
    expect(discoverRustcDriver(d)).toBeNull();
  });

  it("never throws when probes time out, fail, or the host throws", () => {
    const d = deps({ env: { CODEGRAPH_RUST_DRIVER_PATH: "/x/drv" }, existing: [`/opt/bin/${BIN}`] });
    d.run.mockImplementation(() => ({ kind: "timed-out" }));
    expect(discoverRustcDriver(d)).toBeNull();
    d.run.mockImplementation(() => {
      throw new Error("boom");
    });
    expect(discoverRustcDriver(d)).toBeNull();
  });
});

describe("rustcDriverInstallHint", () => {
  it("names tea-rags rustc-driver install, the pin and the escape-hatch env var", () => {
    expect(rustcDriverInstallHint(PIN)).toBe(
      `rustc call-site driver unavailable — install with 'tea-rags rustc-driver install', build it with 'rustup toolchain install ${PIN} -c rustc-dev,rust-src' (≈1.5 GB), or set CODEGRAPH_RUST_DRIVER_PATH`,
    );
  });
});
