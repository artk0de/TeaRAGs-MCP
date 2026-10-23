/**
 * Which `tearags-rust-callsites` the Rust codegraph's rustc call-site slot runs,
 * or whether it can be built (research/rustc-driver/SPEC.md §8.2). Mirrors
 * `adapters/rust-analyzer/rust-analyzer-executable.ts`: a candidate is usable
 * only when RUNNING `<candidate> -V` answers a parseable banner whose pin is
 * the expected one — never by `existsSync` alone.
 *
 * Order (first usable wins):
 *   1. `CODEGRAPH_RUST_DRIVER_PATH` — this exact name, no alias.
 *   2. `tearags-rust-callsites` on PATH.
 *   3. The data-dir build cache `${dataDir}/rustc-driver/bin/<pin>-<sourceHash>/`.
 *   4. "buildable": the pinned toolchain is installed WITH rustc-dev —
 *      `rustup which --toolchain <pin> rustc`, then
 *      `${RUSTUP_HOME:-~/.rustup}/toolchains/<pin>-<host>/`, then asdf
 *      (`${ASDF_DATA_DIR:-~/.asdf}/installs/rust/*`). Homebrew rust has no
 *      rustc-dev and never satisfies it. The build itself is not done here.
 *   5. Nothing → null; the caller shows {@link rustcDriverInstallHint}.
 *
 * Absence never throws, and neither does a failing or hanging probe: a timeout
 * is a verdict ("not this candidate"). Host access is injected; the pin and the
 * expected source hash are injected too, so this module owns no pin.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Env var naming an explicit prebuilt binary. The ONLY spelling read. */
export const RUSTC_DRIVER_PATH_ENV = "CODEGRAPH_RUST_DRIVER_PATH";

/** `-V` probe window per candidate. */
export const RUSTC_DRIVER_VERSION_TIMEOUT_MS = 5000;

const BINARY = "tearags-rust-callsites";

/** Which discovery tier produced the answer. */
export type RustcDriverDiscoveryTier = "env" | "path" | "cache" | "rustup" | "asdf";

/** The parsed `-V` banner: `<name> <version> <pin> <sourceHash>`. */
export interface RustcDriverVersion {
  version: string;
  pin: string;
  sourceHash: string;
}

/** A prebuilt driver that answered `-V` with the expected pin. */
export interface RustcDriverBinary extends RustcDriverVersion {
  kind: "binary";
  tier: "env" | "path" | "cache";
  path: string;
}

/** No binary, but the pinned toolchain with rustc-dev is installed: a build can run. */
export interface RustcDriverBuildable {
  kind: "buildable";
  tier: "rustup" | "asdf";
  sysroot: string;
  host: string;
}

export type RustcDriverDiscovery = RustcDriverBinary | RustcDriverBuildable;

/** Outcome of running one host command. */
export type RustcDriverCommandOutcome = { kind: "ok"; stdout: string } | { kind: "failed" } | { kind: "timed-out" };

export interface RustcDriverDiscoveryDeps {
  /** Toolchain channel the driver is pinned to. */
  pin: string;
  /** Source hash the cached build directory is keyed by. */
  sourceHash: string;
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** `${TEA_RAGS_DATA_DIR:-~/.tea-rags}`. */
  dataDir: string;
  run: (command: string, args: readonly string[], timeoutMs: number) => RustcDriverCommandOutcome;
  fs: {
    exists: (path: string) => boolean;
    listDir: (path: string) => readonly string[];
  };
}

/** Parse a `-V` banner; null for anything that is not one. */
export function parseRustcDriverVersion(stdout: string): RustcDriverVersion | null {
  const tokens = stdout.trim().split(/\s+/);
  if (tokens.length < 3) return null;
  const [version, pin, sourceHash] = tokens.slice(-3);
  return { version, pin, sourceHash };
}

/** The one install-hint line shown when the driver is neither found nor buildable. */
export function rustcDriverInstallHint(pin: string): string {
  return `rustc call-site driver unavailable — install with 'rustup toolchain install ${pin} -c rustc-dev,rust-src' (≈1.5 GB), or set ${RUSTC_DRIVER_PATH_ENV}`;
}

/** First usable driver in the mandated tier order, or null. Never throws. */
export function discoverRustcDriver(deps: RustcDriverDiscoveryDeps): RustcDriverDiscovery | null {
  try {
    return discoverBinary(deps) ?? discoverBuildable(deps);
  } catch {
    return null;
  }
}

function discoverBinary(deps: RustcDriverDiscoveryDeps): RustcDriverBinary | null {
  const tiers: ["env" | "path" | "cache", () => Iterable<string>][] = [
    ["env", () => envCandidates(deps)],
    ["path", () => pathCandidates(deps)],
    ["cache", () => cacheCandidates(deps)],
  ];
  for (const [tier, candidates] of tiers) {
    for (const path of candidates()) {
      const version = probeVersion(deps, path);
      if (version) return { kind: "binary", tier, path, ...version };
    }
  }
  return null;
}

function probeVersion(deps: RustcDriverDiscoveryDeps, candidate: string): RustcDriverVersion | null {
  const outcome = deps.run(candidate, ["-V"], RUSTC_DRIVER_VERSION_TIMEOUT_MS);
  if (outcome.kind !== "ok") return null;
  const version = parseRustcDriverVersion(outcome.stdout);
  return version?.pin === deps.pin ? version : null;
}

function envCandidates(deps: RustcDriverDiscoveryDeps): string[] {
  const explicit = deps.env[RUSTC_DRIVER_PATH_ENV];
  return explicit ? [explicit] : [];
}

function* pathCandidates(deps: RustcDriverDiscoveryDeps): Iterable<string> {
  for (const dir of (deps.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, BINARY);
    if (deps.fs.exists(candidate)) yield candidate;
  }
}

function* cacheCandidates(deps: RustcDriverDiscoveryDeps): Iterable<string> {
  const candidate = join(deps.dataDir, "rustc-driver", "bin", `${deps.pin}-${deps.sourceHash}`, BINARY);
  if (deps.fs.exists(candidate)) yield candidate;
}

function discoverBuildable(deps: RustcDriverDiscoveryDeps): RustcDriverBuildable | null {
  const tiers: ["rustup" | "asdf", () => Iterable<string>][] = [
    ["rustup", () => rustupSysroots(deps)],
    ["asdf", () => asdfSysroots(deps)],
  ];
  for (const [tier, sysroots] of tiers) {
    for (const sysroot of sysroots()) {
      const host = rustcDevHost(deps, sysroot);
      if (host) return { kind: "buildable", tier, sysroot, host };
    }
  }
  return null;
}

function* rustupSysroots(deps: RustcDriverDiscoveryDeps): Iterable<string> {
  const outcome = deps.run("rustup", ["which", "--toolchain", deps.pin, "rustc"], RUSTC_DRIVER_VERSION_TIMEOUT_MS);
  if (outcome.kind === "ok" && outcome.stdout.trim().length > 0) yield dirname(dirname(outcome.stdout.trim()));
  yield* pinnedToolchainDirs(deps, join(deps.env.RUSTUP_HOME ?? join(deps.homeDir, ".rustup"), "toolchains"));
}

function* asdfSysroots(deps: RustcDriverDiscoveryDeps): Iterable<string> {
  const installs = join(deps.env.ASDF_DATA_DIR ?? join(deps.homeDir, ".asdf"), "installs", "rust");
  for (const version of deps.fs.listDir(installs)) {
    yield* pinnedToolchainDirs(deps, join(installs, version, "toolchains"));
  }
}

function* pinnedToolchainDirs(deps: RustcDriverDiscoveryDeps, toolchainsDir: string): Iterable<string> {
  for (const entry of deps.fs.listDir(toolchainsDir)) {
    if (entry.startsWith(`${deps.pin}-`)) yield join(toolchainsDir, entry);
  }
}

/** The host triple whose lib dir carries rustc-dev (`librustc_driver-*` + `rustc_middle-*.rlib`), or null. */
function rustcDevHost(deps: RustcDriverDiscoveryDeps, sysroot: string): string | null {
  const rustlib = join(sysroot, "lib", "rustlib");
  for (const host of deps.fs.listDir(rustlib)) {
    const libs = deps.fs.listDir(join(rustlib, host, "lib"));
    const hasDriver = libs.some((name) => name.startsWith("librustc_driver-"));
    const hasMiddle = libs.some((name) => name.startsWith("librustc_middle-") && name.endsWith(".rlib"));
    if (hasDriver && hasMiddle) return host;
  }
  return null;
}

/** Discovery bound to the real host. */
export function defaultRustcDriverDiscoveryDeps(
  pin: string,
  sourceHash: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RustcDriverDiscoveryDeps {
  return {
    pin,
    sourceHash,
    env,
    homeDir: homedir(),
    dataDir: env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"),
    run: runRustcDriverHostCommand,
    fs: {
      exists: (path) => existsSync(path),
      listDir: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return [];
        }
      },
    },
  };
}

export function runRustcDriverHostCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
): RustcDriverCommandOutcome {
  try {
    const result = spawnSync(command, args, {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }) as ReturnType<typeof spawnSync> | undefined;
    if (!result) return { kind: "failed" };
    const spawnError: NodeJS.ErrnoException | undefined = result.error;
    if (spawnError?.code === "ETIMEDOUT") return { kind: "timed-out" };
    if (spawnError || result.status !== 0) return { kind: "failed" };
    return { kind: "ok", stdout: String(result.stdout) };
  } catch {
    return { kind: "failed" };
  }
}
