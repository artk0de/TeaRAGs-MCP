import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  runRustcDriverInstall,
  runRustcDriverStatus,
  type RustcDriverInstallDeps,
} from "../../../src/cli/commands/rustc-driver.js";

function installDeps(overrides: Partial<RustcDriverInstallDeps> = {}): RustcDriverInstallDeps {
  return {
    out: vi.fn(),
    env: { TEA_RAGS_DATA_DIR: "/data" },
    home: "/home/u",
    platform: "linux",
    arch: "x64",
    version: "1.50.0",
    download: vi.fn(async () => "/data/rustc-driver/bin/pin-hash/tea-rags-rustc-driver"),
    installToolchain: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("runRustcDriverInstall", () => {
  it("downloads the release of this version into the data dir, then installs the pinned toolchain there", async () => {
    const deps = installDeps();

    await runRustcDriverInstall({}, deps);

    expect(deps.download).toHaveBeenCalledWith({ version: "1.50.0", dataDir: "/data", platform: "linux", arch: "x64" });
    expect(deps.installToolchain).toHaveBeenCalledWith({ dataDir: "/data", platform: "linux" });
    expect(deps.out).toHaveBeenCalledWith("/data/rustc-driver/bin/pin-hash/tea-rags-rustc-driver");
  });

  it("honours --version and --skip-toolchain, defaulting the data dir to ~/.tea-rags", async () => {
    const deps = installDeps({ env: {} });

    await runRustcDriverInstall({ version: "1.49.0", skipToolchain: true }, deps);

    expect(deps.download).toHaveBeenCalledWith({
      version: "1.49.0",
      dataDir: join("/home/u", ".tea-rags"),
      platform: "linux",
      arch: "x64",
    });
    expect(deps.installToolchain).not.toHaveBeenCalled();
  });
});

describe("runRustcDriverStatus", () => {
  it("prints the live discovery as JSON", () => {
    const out = vi.fn();
    runRustcDriverStatus({
      out,
      status: () => ({
        pin: "nightly-2026-05-01",
        discovery: {
          kind: "binary",
          tier: "cache",
          path: "/d/x",
          version: "0.1.0",
          pin: "nightly-2026-05-01",
          sourceHash: "h",
        },
        managedToolchain: true,
      }),
    });

    expect(JSON.parse(out.mock.calls[0][0] as string)).toMatchObject({
      pin: "nightly-2026-05-01",
      available: true,
      tier: "cache",
      path: "/d/x",
      managedToolchain: true,
    });
  });

  it("reports unavailable with the install hint when nothing is found", () => {
    const out = vi.fn();
    runRustcDriverStatus({
      out,
      status: () => ({ pin: "nightly-2026-05-01", discovery: null, managedToolchain: false }),
    });

    expect(JSON.parse(out.mock.calls[0][0] as string)).toMatchObject({ available: false, tier: null });
  });
});
