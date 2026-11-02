/**
 * `tea-rags rustc-driver <subcommand>` — the prebuilt Rust call-site driver.
 *
 * `install` downloads the driver archive of this tea-rags version's GitHub
 * Release into the data-dir build cache (discovery finds it there as tier
 * `cache`) and installs the pinned nightly it links against under
 * `<data dir>/rust/`, leaving the user's own rustup/cargo homes untouched.
 * `status` prints what discovery answers right now. Work runs over injected
 * deps so tests use object literals.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Argv, CommandModule } from "yargs";

import {
  downloadRustcDriverRelease,
  installRustcDriverToolchain,
  RUSTC_DRIVER_TOOLCHAIN_PIN,
  rustcDriverInstallStatus,
  type RustcDriverInstallStatus,
} from "../../core/api/public/index.js";
import { PackageJsonVersionSource } from "../update-check/version-source.js";

export interface RustcDriverInstallArgs {
  /** Release to install from; defaults to this tea-rags version. */
  version?: string;
  /** Download the driver only; the pinned toolchain is installed elsewhere. */
  skipToolchain?: boolean;
}

export interface RustcDriverInstallDeps {
  out: (line: string) => void;
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  arch: string;
  /** This tea-rags version. */
  version: string;
  download: (o: { version: string; dataDir: string; platform: NodeJS.Platform; arch: string }) => Promise<string>;
  installToolchain: (o: { dataDir: string; platform: NodeJS.Platform }) => Promise<void>;
}

export interface RustcDriverStatusDeps {
  out: (line: string) => void;
  status: () => RustcDriverInstallStatus;
}

function dataDirOf(env: NodeJS.ProcessEnv, home: string): string {
  return env.TEA_RAGS_DATA_DIR ?? join(home, ".tea-rags");
}

/** Download, then toolchain; the driver path is printed once it is published. */
export async function runRustcDriverInstall(args: RustcDriverInstallArgs, deps: RustcDriverInstallDeps): Promise<void> {
  const dataDir = dataDirOf(deps.env, deps.home);
  const version = args.version ?? deps.version;
  deps.out(`rustc-driver: downloading the v${version} release for ${deps.platform}-${deps.arch}`);
  deps.out(await deps.download({ version, dataDir, platform: deps.platform, arch: deps.arch }));
  if (args.skipToolchain) return;
  deps.out(`rustc-driver: installing toolchain ${RUSTC_DRIVER_TOOLCHAIN_PIN} under ${join(dataDir, "rust")}`);
  await deps.installToolchain({ dataDir, platform: deps.platform });
  deps.out("rustc-driver: ready");
}

/** One JSON object: `{ pin, available, tier, path, managedToolchain, hint? }`. */
export function runRustcDriverStatus(deps: RustcDriverStatusDeps): void {
  const { pin, discovery, managedToolchain, hint } = deps.status();
  deps.out(
    JSON.stringify({
      pin,
      available: discovery !== null,
      tier: discovery?.tier ?? null,
      path: discovery?.kind === "binary" ? discovery.path : null,
      managedToolchain,
      ...(hint ? { hint } : {}),
    }),
  );
}

const execFileAsync = promisify(execFile);

/** Long-running installers stream to the terminal; a non-zero exit rejects. */
async function runInherited(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code ?? "by signal"}`));
    });
  });
}

function productionInstallDeps(): RustcDriverInstallDeps {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    env: process.env,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
    version: new PackageJsonVersionSource().getCurrent(),
    download: async (o) =>
      downloadRustcDriverRelease(o, {
        fetch: async (input, init) => fetch(input, init),
        run: async (cmd, args) => {
          await execFileAsync(cmd, args);
        },
      }),
    installToolchain: async (o) =>
      installRustcDriverToolchain(
        { pin: RUSTC_DRIVER_TOOLCHAIN_PIN, ...o },
        { run: runInherited, exists: (path) => existsSync(path) },
      ),
  };
}

export const rustcDriverCommand: CommandModule = {
  command: "rustc-driver",
  describe: "Prebuilt rustc call-site driver for the Rust codegraph (install, status)",
  builder: (yargs: Argv) =>
    yargs
      .command(
        "install",
        "Download the prebuilt driver from the GitHub Release and install its pinned nightly under the data dir",
        (y) =>
          y
            .option("version", {
              type: "string",
              describe: "tea-rags release to install from (default: this version)",
            })
            .option("skip-toolchain", {
              type: "boolean",
              default: false,
              describe: "Download the driver only, without the pinned toolchain",
            }),
        async (argv) => {
          await runRustcDriverInstall(
            { version: argv.version, skipToolchain: argv.skipToolchain },
            productionInstallDeps(),
          );
        },
      )
      .command(
        "status",
        "Print as JSON which rustc driver the Rust codegraph would use now",
        (y) => y,
        () => {
          runRustcDriverStatus({
            out: (line) => process.stdout.write(`${line}\n`),
            status: () => rustcDriverInstallStatus(process.env, (path) => existsSync(path)),
          });
        },
      )
      .demandCommand(1)
      .strict(),
  handler: () => {
    // never reached — yargs delegates to subcommands
  },
};
