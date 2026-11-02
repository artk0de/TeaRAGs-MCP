/**
 * The rust toolchain `tea-rags rustc-driver install` puts under the data dir:
 * `RUSTUP_HOME=${dataDir}/rust/rustup`, `CARGO_HOME=${dataDir}/rust/cargo`, so
 * the user's own rustup/cargo homes stay untouched.
 *
 * A prebuilt driver links `librustc_driver` of the pinned nightly through an
 * rpath of the CI machine, which does not exist here — so every spawn of the
 * driver, and of `rustup` itself, runs with {@link managedRustToolchainEnv}:
 * the managed homes, their `cargo/bin` first on PATH, and the loader search
 * path pointed at the pinned toolchain's libraries.
 */

import { delimiter, join } from "node:path";

import { RUSTC_DRIVER_TOOLCHAIN_PIN } from "./pin.js";

/** `${dataDir}/rust` and the two homes inside it. */
export function managedRustHomes(dataDir: string): { root: string; rustupHome: string; cargoHome: string } {
  const root = join(dataDir, "rust");
  return { root, rustupHome: join(root, "rustup"), cargoHome: join(root, "cargo") };
}

const HOST_TRIPLES: Readonly<Record<string, string>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
};

/** The rustup host triple of a Node platform/arch, or undefined when tea-rags ships no driver for it. */
export function rustcHostTriple(platform: NodeJS.Platform, arch: string): string | undefined {
  return HOST_TRIPLES[`${platform}-${arch}`];
}

function prepend(dir: string, current: string | undefined): string {
  return current ? `${dir}${delimiter}${current}` : dir;
}

/**
 * `base` overlaid with the managed toolchain when `${dataDir}/rust` exists;
 * `base` itself otherwise (the user's toolchain or a local build serves).
 */
export function managedRustToolchainEnv(
  base: Readonly<Record<string, string | undefined>>,
  dataDir: string,
  host: { platform: NodeJS.Platform; arch: string; exists: (path: string) => boolean },
): Record<string, string | undefined> {
  const homes = managedRustHomes(dataDir);
  if (!host.exists(homes.root)) return { ...base };

  const env: Record<string, string | undefined> = {
    ...base,
    RUSTUP_HOME: homes.rustupHome,
    CARGO_HOME: homes.cargoHome,
    PATH: prepend(join(homes.cargoHome, "bin"), base.PATH),
  };
  const triple = rustcHostTriple(host.platform, host.arch);
  if (!triple) return env;
  const toolchain = join(homes.rustupHome, "toolchains", `${RUSTC_DRIVER_TOOLCHAIN_PIN}-${triple}`);
  // Where each loader looks for librustc_driver: DLLs beside bin/ on Windows, lib/ elsewhere.
  if (host.platform === "win32") {
    env.PATH = prepend(join(toolchain, "bin"), env.PATH);
  } else if (host.platform === "darwin") {
    env.DYLD_FALLBACK_LIBRARY_PATH = prepend(join(toolchain, "lib"), base.DYLD_FALLBACK_LIBRARY_PATH);
  } else {
    env.LD_LIBRARY_PATH = prepend(join(toolchain, "lib"), base.LD_LIBRARY_PATH);
  }
  return env;
}
