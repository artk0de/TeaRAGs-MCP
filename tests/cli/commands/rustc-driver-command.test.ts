import { afterEach, describe, expect, it, vi } from "vitest";
import yargs from "yargs";

import { rustcDriverCommand } from "../../../src/cli/commands/rustc-driver.js";
import { RustcDriverReleaseUnavailableError } from "../../../src/core/adapters/rustc-driver/errors.js";
import type * as PublicApi from "../../../src/core/api/public/index.js";

const download = vi.hoisted(() => vi.fn(async () => "/data/rustc-driver/bin/pin-hash/tea-rags-rustc-driver"));

vi.mock("../../../src/core/api/public/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof PublicApi>()),
  downloadRustcDriverRelease: download,
}));

async function runCommand(...argv: string[]): Promise<void> {
  await yargs(argv).command(rustcDriverCommand).exitProcess(false).parseAsync();
}

// The install command's own flags, as a user types them (live install run, 2026-11-02).
describe("tea-rags rustc-driver install", () => {
  afterEach(() => {
    download.mockClear();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("installs from the release named by --release, not the yargs version flag", async () => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await runCommand("rustc-driver", "install", "--release", "1.49.0", "--skip-toolchain");
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ version: "1.49.0" }), expect.anything());
  });

  it("prints a typed failure as message + hint and exits 1, without a stack or the help screen", async () => {
    download.mockRejectedValueOnce(new RustcDriverReleaseUnavailableError("v9.9.9 manifest answered 404"));
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runCommand("rustc-driver", "install", "--release", "9.9.9", "--skip-toolchain");

    const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(printed).toContain("rustc-driver install: No prebuilt rustc call-site driver: v9.9.9 manifest answered 404");
    expect(printed).toContain(
      "Build it locally instead: rustup toolchain install nightly-2026-05-01 -c rustc-dev,rust-src",
    );
    expect(printed).not.toContain("    at ");
    expect(errorLog).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
