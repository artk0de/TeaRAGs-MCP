/**
 * Prebuilt `tea-rags-rustc-driver` from the TeaRAGs GitHub Release of a
 * version, and the pinned toolchain it links against.
 *
 * The release carries one archive per platform plus `rustc-driver-manifest.json`
 * `{ pin, sourceHash, assets: { <platform>: { asset, sha256 } } }`. The archive
 * is published into the same `${dataDir}/rustc-driver/bin/<pin>-<sourceHash>/`
 * a local build installs into, so discovery finds it as tier `cache` with no
 * code of its own. A manifest built from another pin or driver source is
 * refused: its banner would never match what discovery expects.
 */

import { access, rm } from "node:fs/promises";
import { join } from "node:path";

import { downloadVerifiedFile, publishArchive, type NativeAssetDeps } from "../native-assets/index.js";
import { defaultRustcCallSiteRunnerDeps, rustcDriverCrateDir } from "./callsite-runner.js";
import {
  computeRustcDriverSourceHash,
  defaultRustcDriverSourceFs,
  RUSTC_DRIVER_CLI_BINARY,
  RUSTC_DRIVER_WRAPPER_BINARY,
} from "./driver-build.js";
import { RustcDriverReleaseStaleError, RustcDriverReleaseUnavailableError } from "./errors.js";
import { rustcDriverInstallHint, type RustcDriverDiscovery } from "./executable.js";
import { managedRustHomes } from "./managed-toolchain.js";
import { RUSTC_DRIVER_TOOLCHAIN_PIN } from "./pin.js";

export { managedRustToolchainEnv } from "./managed-toolchain.js";
export { RUSTC_DRIVER_TOOLCHAIN_PIN } from "./pin.js";

/** GitHub `owner/repo` whose releases carry the driver archives. */
export const RUSTC_DRIVER_RELEASE_REPOSITORY = "artk0de/TeaRAGs-MCP";

/** Release asset naming the per-platform archives and their digests. */
export const RUSTC_DRIVER_RELEASE_MANIFEST_ASSET = "rustc-driver-manifest.json";

export interface RustcDriverReleaseManifest {
  pin: string;
  sourceHash: string;
  /** Keyed by {@link rustcDriverReleaseAssetPlatform}. */
  assets: Record<string, { asset: string; sha256: string }>;
}

const RELEASE_PLATFORMS: Readonly<Record<string, string>> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "win32-x64": "windows-x64",
};

/** The release's platform key for a Node platform/arch; undefined when the release builds none. */
export function rustcDriverReleaseAssetPlatform(platform: NodeJS.Platform, arch: string): string | undefined {
  return RELEASE_PLATFORMS[`${platform}-${arch}`];
}

function executableName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${name}.exe` : name;
}

function releaseDownloadUrl(version: string, asset: string): string {
  return `https://github.com/${RUSTC_DRIVER_RELEASE_REPOSITORY}/releases/download/v${version}/${asset}`;
}

async function isPublished(binDir: string, binaries: readonly string[]): Promise<boolean> {
  try {
    for (const name of binaries) await access(join(binDir, name));
    return true;
  } catch {
    return false;
  }
}

async function fetchReleaseManifest(version: string, deps: NativeAssetDeps): Promise<RustcDriverReleaseManifest> {
  const url = releaseDownloadUrl(version, RUSTC_DRIVER_RELEASE_MANIFEST_ASSET);
  let response: Response;
  try {
    response = await deps.fetch(url, { redirect: "follow" });
  } catch (error) {
    throw new RustcDriverReleaseUnavailableError(`fetching ${url} failed`, error as Error);
  }
  if (!response.ok) throw new RustcDriverReleaseUnavailableError(`${url} answered ${response.status}`);
  return (await response.json()) as RustcDriverReleaseManifest;
}

/**
 * Fetches rustc-driver-manifest.json from the release of `version`, downloads
 * this platform's archive into `${dataDir}/rustc-driver/bin/<pin>-<sourceHash>/`
 * via publishArchive; returns the binary path. Manifest pin/sourceHash ≠
 * RUSTC_DRIVER_TOOLCHAIN_PIN / computeRustcDriverSourceHash() → throws (stale
 * release).
 */
export async function downloadRustcDriverRelease(
  o: { version: string; dataDir: string; platform: NodeJS.Platform; arch: string },
  deps: NativeAssetDeps & { run: (cmd: string, args: string[]) => Promise<void> },
): Promise<string> {
  const platformKey = rustcDriverReleaseAssetPlatform(o.platform, o.arch);
  if (!platformKey) throw new RustcDriverReleaseUnavailableError(`no release build for ${o.platform}-${o.arch}`);

  const expected = {
    pin: RUSTC_DRIVER_TOOLCHAIN_PIN,
    sourceHash: computeRustcDriverSourceHash(rustcDriverCrateDir(), defaultRustcDriverSourceFs),
  };
  const root = join(o.dataDir, "rustc-driver");
  const binDir = join(root, "bin", `${expected.pin}-${expected.sourceHash}`);
  const binaries = [RUSTC_DRIVER_CLI_BINARY, RUSTC_DRIVER_WRAPPER_BINARY].map((name) =>
    executableName(name, o.platform),
  );
  // Published dirs are complete by construction (publishArchive), so presence is the whole check.
  if (await isPublished(binDir, binaries)) return join(binDir, binaries[0]);

  const manifest = await fetchReleaseManifest(o.version, deps);
  if (manifest.pin !== expected.pin || manifest.sourceHash !== expected.sourceHash) {
    throw new RustcDriverReleaseStaleError(manifest, expected);
  }
  const entry = manifest.assets[platformKey] as { asset: string; sha256: string } | undefined;
  if (!entry) throw new RustcDriverReleaseUnavailableError(`release v${o.version} has no ${platformKey} archive`);

  const archive = await downloadVerifiedFile(
    { url: releaseDownloadUrl(o.version, entry.asset), sha256: entry.sha256, fileName: entry.asset },
    join(root, "downloads"),
    deps,
  );
  try {
    await publishArchive(
      archive,
      binDir,
      async (stagingDir) => {
        // -V cannot run yet: the pinned toolchain may not be installed. sha256 vouches for the bytes.
        if (!(await isPublished(stagingDir, binaries))) {
          throw new RustcDriverReleaseUnavailableError(`${entry.asset} lacks ${binaries.join(" / ")}`);
        }
      },
      deps,
    );
  } finally {
    // A kept archive would be reused by digest on the next run, failing the same way forever.
    await rm(archive, { force: true });
  }
  return join(binDir, binaries[0]);
}

/**
 * rustup toolchain install <pin> --profile minimal with RUSTUP_HOME/CARGO_HOME
 * under `${dataDir}/rust/`; rustup missing → installs rustup-init with
 * --no-modify-path into the same home.
 */
export async function installRustcDriverToolchain(
  o: { pin: string; dataDir: string; platform?: NodeJS.Platform },
  deps: {
    run: (cmd: string, args: string[], env: Record<string, string>) => Promise<void>;
    exists: (p: string) => boolean;
  },
): Promise<void> {
  const platform = o.platform ?? process.platform;
  const homes = managedRustHomes(o.dataDir);
  const env = { RUSTUP_HOME: homes.rustupHome, CARGO_HOME: homes.cargoHome };
  const rustup = join(homes.cargoHome, "bin", executableName("rustup", platform));

  if (!deps.exists(rustup)) {
    const initArgs = "-y --no-modify-path --profile minimal --default-toolchain none";
    if (platform === "win32") {
      await deps.run(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$f = Join-Path $env:TEMP 'rustup-init.exe'; Invoke-WebRequest -Uri https://win.rustup.rs/x86_64 -OutFile $f; & $f ${initArgs}`,
        ],
        env,
      );
    } else {
      await deps.run(
        "sh",
        ["-c", `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- ${initArgs}`],
        env,
      );
    }
  }
  await deps.run(rustup, ["toolchain", "install", o.pin, "--profile", "minimal"], env);
}

export interface RustcDriverInstallStatus {
  pin: string;
  /** The driver the codegraph run would use right now, probed under the managed env. */
  discovery: RustcDriverDiscovery | null;
  /** `${dataDir}/rust` exists — `rustc-driver install` put a toolchain there. */
  managedToolchain: boolean;
  /** The install hint; present only when no driver is found. */
  hint?: string;
}

/** What `tea-rags rustc-driver status` reports, read live from the host. */
export function rustcDriverInstallStatus(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean,
): RustcDriverInstallStatus {
  const deps = defaultRustcCallSiteRunnerDeps(env);
  const discovery = deps.discover();
  return {
    pin: deps.pin,
    discovery,
    managedToolchain: exists(managedRustHomes(deps.dataDir).root),
    ...(discovery === null ? { hint: rustcDriverInstallHint(deps.pin) } : {}),
  };
}
