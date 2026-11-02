import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { rustcDriverCommand } from "../../../src/cli/commands/rustc-driver.js";

const download = vi.hoisted(() => vi.fn());
const installToolchain = vi.hoisted(() => vi.fn());
const status = vi.hoisted(() => vi.fn());

vi.mock("../../../src/core/api/public/index.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    downloadRustcDriverRelease: download,
    installRustcDriverToolchain: installToolchain,
    rustcDriverInstallStatus: status,
  };
});

let written: string[];

beforeEach(() => {
  written = [];
  download.mockReset().mockImplementation(async (_o: unknown, deps: { fetch: unknown; run: unknown }) => {
    expect(typeof deps.fetch).toBe("function");
    // The archive extractor runs through the injected `run`.
    await (deps.run as (c: string, a: string[]) => Promise<void>)(process.execPath, ["-e", "0"]);
    return "/data/rustc-driver/bin/pin/tea-rags-rustc-driver";
  });
  installToolchain.mockReset().mockImplementation(async (_o: unknown, deps: { run: unknown; exists: unknown }) => {
    const run = deps.run as (c: string, a: string[], e: Record<string, string>) => Promise<void>;
    await run(process.execPath, ["-e", "0"], { FOO: "bar" });
    await expect(run(process.execPath, ["-e", "process.exit(2)"], {})).rejects.toThrow(/exited 2/);
    await expect(run(join_missing(), [], {})).rejects.toThrow();
    expect((deps.exists as (p: string) => boolean)(process.execPath)).toBe(true);
  });
  status.mockReset().mockReturnValue({
    pin: "nightly-x",
    discovery: { tier: "cache", kind: "binary", path: "/p/driver" },
    managedToolchain: false,
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function join_missing(): string {
  return "/definitely/not/a/real/binary-xyz";
}

async function run(...argv: string[]): Promise<void> {
  await yargs(argv).command(rustcDriverCommand).fail(false).parseAsync();
}

describe("rustc-driver command wired through yargs", () => {
  it("install downloads the driver, then installs the pinned toolchain unless --skip-toolchain", async () => {
    await run("rustc-driver", "install");
    expect(download).toHaveBeenCalledTimes(1);
    expect(installToolchain).toHaveBeenCalledTimes(1);
    expect(written.join("")).toContain("tea-rags-rustc-driver");

    download.mockClear();
    installToolchain.mockClear();
    await run("rustc-driver", "install", "--skip-toolchain");
    expect(download).toHaveBeenCalledTimes(1);
    expect(installToolchain).not.toHaveBeenCalled();
  });

  it("status prints the discovery answer as JSON", async () => {
    await run("rustc-driver", "status");
    expect(JSON.parse(written.join(""))).toEqual({
      pin: "nightly-x",
      available: true,
      tier: "cache",
      path: "/p/driver",
      managedToolchain: false,
    });
  });

  it("requires a subcommand", async () => {
    await expect(run("rustc-driver")).rejects.toThrow();
  });
});
