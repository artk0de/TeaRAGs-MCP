/**
 * First-use build of the rustc call-site driver crate (research/rustc-driver/SPEC.md §8.1, §8.4).
 *
 * The two binaries land in `${dataDir}/rustc-driver/bin/<pin>-<sourceHash>/` — the directory
 * `executable.ts` probes as its "cache" tier. Three rules:
 *   - Present directory → reuse, nothing spawned.
 *   - A failed build is LATCHED per (pin, sourceHash) in `<pin>-<sourceHash>.latch.json` beside the
 *     directory, so an index run does not pay a cargo build each time. A new sourceHash or pin is a
 *     new key and retries. Build failure never throws: it is a typed result.
 *   - The install is atomic: binaries are staged in a sibling directory, verified by `-V`, and the
 *     whole directory is renamed into place. A failure leaves no half-written `<pin>-<sourceHash>/`.
 *
 * The build env is forced to the pinned toolchain (`RUSTUP_TOOLCHAIN`, `RUSTC`, `CARGO`, and
 * `<sysroot>/bin` first on PATH): Homebrew cargo/rustc shadow the rustup proxies on some hosts and
 * would otherwise build with a toolchain that has no rustc-dev (SPEC §2).
 *
 * The crate directory, pin, sourceHash and every host effect are injected.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { parseRustcDriverVersion, type RustcDriverBuildable } from "./executable.js";

/** Default window for the whole `cargo build`. */
export const RUSTC_DRIVER_BUILD_TIMEOUT_MS = 600_000;
/** `-V` verification window of the freshly built binary. */
const VERIFY_TIMEOUT_MS = 5000;
/** Output kept for the build log. */
const MAX_LOG_CHARS = 1_000_000;

export const RUSTC_DRIVER_CLI_BINARY = "tearags-rust-callsites";
export const RUSTC_DRIVER_WRAPPER_BINARY = "tearags-rust-callsites-driver";

export type RustcDriverBuildFailureReason =
  | "latched"
  | "build-failed"
  | "timed-out"
  | "binary-missing"
  | "banner-mismatch"
  | "install-failed";

export interface RustcDriverBuilt {
  ok: true;
  /** True when this call ran cargo; false when the directory already existed. */
  built: boolean;
  binDir: string;
  /** The cargo-side CLI (`tearags-rust-callsites`). */
  binaryPath: string;
  /** The `RUSTC_WORKSPACE_WRAPPER` (`tearags-rust-callsites-driver`). */
  wrapperPath: string;
}

export interface RustcDriverBuildFailed {
  ok: false;
  reason: RustcDriverBuildFailureReason;
  /** One line for the status surface. */
  detail: string;
  logPath: string;
}

export type RustcDriverBuildResult = RustcDriverBuilt | RustcDriverBuildFailed;

/** Outcome of one spawned command; `output` is merged stdout+stderr. */
export type RustcDriverSpawnOutcome =
  | { kind: "exited"; status: number; output: string }
  | { kind: "timed-out"; output: string }
  | { kind: "spawn-failed"; output: string };

export interface RustcDriverBuildFs {
  exists: (path: string) => boolean;
  readText: (path: string) => string;
  writeText: (path: string, content: string) => void;
  mkdirp: (path: string) => void;
  copyFile: (from: string, to: string) => void;
  rename: (from: string, to: string) => void;
  remove: (path: string) => void;
}

interface RustcDriverSpawnOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs: number;
}

export interface RustcDriverBuildDeps {
  /** `native/rust-callsites` of the installed package. */
  crateDir: string;
  pin: string;
  sourceHash: string;
  /** `${TEA_RAGS_DATA_DIR:-~/.tea-rags}`. */
  dataDir: string;
  /** Env the build inherits before forcing. */
  env: Readonly<Record<string, string | undefined>>;
  run: (command: string, args: readonly string[], options: RustcDriverSpawnOptions) => Promise<RustcDriverSpawnOutcome>;
  fs: RustcDriverBuildFs;
  now?: () => Date;
  /** Defaults to {@link RUSTC_DRIVER_BUILD_TIMEOUT_MS}. */
  timeoutMs?: number;
}

interface BuildPaths {
  binDir: string;
  stagingDir: string;
  targetDir: string;
  latchPath: string;
  logPath: string;
}

interface LatchRecord {
  pin: string;
  sourceHash: string;
  reason: RustcDriverBuildFailureReason;
  detail: string;
  at: string;
}

function buildPaths(deps: RustcDriverBuildDeps): BuildPaths {
  const root = join(deps.dataDir, "rustc-driver");
  const key = `${deps.pin}-${deps.sourceHash}`;
  return {
    binDir: join(root, "bin", key),
    stagingDir: join(root, "bin", `${key}.staging`),
    targetDir: join(root, "build-tmp", key),
    latchPath: join(root, "bin", `${key}.latch.json`),
    logPath: join(root, "build-logs", `${key}.log`),
  };
}

/** The build environment forced to the pinned toolchain. */
export function rustcDriverBuildEnv(
  base: Readonly<Record<string, string | undefined>>,
  pin: string,
  sysroot: string,
): Record<string, string | undefined> {
  const bin = join(sysroot, "bin");
  return {
    ...base,
    RUSTUP_TOOLCHAIN: pin,
    RUSTC: join(bin, "rustc"),
    CARGO: join(bin, "cargo"),
    PATH: base.PATH ? `${bin}${delimiter}${base.PATH}` : bin,
  };
}

/**
 * The built driver for a `buildable` discovery, building it on first use. Never throws for a build
 * failure — see {@link RustcDriverBuildFailed}.
 */
export async function ensureRustcDriverBuilt(
  deps: RustcDriverBuildDeps,
  buildable: Pick<RustcDriverBuildable, "sysroot">,
): Promise<RustcDriverBuildResult> {
  const paths = buildPaths(deps);
  if (isInstalled(deps, paths.binDir)) return installed(paths.binDir, false);
  const latched = readLatch(deps, paths);
  if (latched) return latched;

  const failure = await buildAndInstall(deps, buildable.sysroot, paths);
  if (failure === null) return installed(paths.binDir, true);
  latchFailure(deps, paths, failure);
  return failure;
}

function installed(binDir: string, built: boolean): RustcDriverBuilt {
  return {
    ok: true,
    built,
    binDir,
    binaryPath: join(binDir, RUSTC_DRIVER_CLI_BINARY),
    wrapperPath: join(binDir, RUSTC_DRIVER_WRAPPER_BINARY),
  };
}

function isInstalled(deps: RustcDriverBuildDeps, binDir: string): boolean {
  return (
    deps.fs.exists(join(binDir, RUSTC_DRIVER_CLI_BINARY)) && deps.fs.exists(join(binDir, RUSTC_DRIVER_WRAPPER_BINARY))
  );
}

function fail(paths: BuildPaths, reason: RustcDriverBuildFailureReason, detail: string): RustcDriverBuildFailed {
  return { ok: false, reason, detail, logPath: paths.logPath };
}

function readLatch(deps: RustcDriverBuildDeps, paths: BuildPaths): RustcDriverBuildFailed | null {
  if (!deps.fs.exists(paths.latchPath)) return null;
  try {
    const parsed = JSON.parse(deps.fs.readText(paths.latchPath)) as Partial<LatchRecord>;
    if (parsed.pin !== deps.pin || parsed.sourceHash !== deps.sourceHash) return null;
    return fail(paths, "latched", `driver build previously failed (${String(parsed.reason)}); see ${paths.logPath}`);
  } catch {
    return null;
  }
}

function latchFailure(deps: RustcDriverBuildDeps, paths: BuildPaths, failure: RustcDriverBuildFailed): void {
  const record: LatchRecord = {
    pin: deps.pin,
    sourceHash: deps.sourceHash,
    reason: failure.reason,
    detail: failure.detail,
    at: (deps.now?.() ?? new Date()).toISOString(),
  };
  try {
    deps.fs.mkdirp(dirname(paths.latchPath));
    deps.fs.writeText(paths.latchPath, JSON.stringify(record));
  } catch {
    // The latch is an optimisation: a read-only data dir only costs a retry next run.
  }
}

async function buildAndInstall(
  deps: RustcDriverBuildDeps,
  sysroot: string,
  paths: BuildPaths,
): Promise<RustcDriverBuildFailed | null> {
  const env = rustcDriverBuildEnv(deps.env, deps.pin, sysroot);
  const outcome = await deps.run(
    join(sysroot, "bin", "cargo"),
    [
      "build",
      "--release",
      "--offline",
      "--manifest-path",
      join(deps.crateDir, "Cargo.toml"),
      "--target-dir",
      paths.targetDir,
    ],
    { env, cwd: deps.crateDir, timeoutMs: deps.timeoutMs ?? RUSTC_DRIVER_BUILD_TIMEOUT_MS },
  );
  writeLog(deps, paths, outcome.output);
  if (outcome.kind === "timed-out") return fail(paths, "timed-out", "cargo build timed out");
  if (outcome.kind === "spawn-failed") return fail(paths, "build-failed", "cargo could not be spawned");
  if (outcome.status !== 0) return fail(paths, "build-failed", `cargo build exited with status ${outcome.status}`);

  try {
    return await stageVerifyAndPublish(deps, env, paths);
  } finally {
    safeRemove(deps, paths.stagingDir);
    safeRemove(deps, paths.targetDir);
  }
}

async function stageVerifyAndPublish(
  deps: RustcDriverBuildDeps,
  env: Record<string, string | undefined>,
  paths: BuildPaths,
): Promise<RustcDriverBuildFailed | null> {
  const releaseDir = join(paths.targetDir, "release");
  const names = [RUSTC_DRIVER_CLI_BINARY, RUSTC_DRIVER_WRAPPER_BINARY];
  const missing = names.find((name) => !deps.fs.exists(join(releaseDir, name)));
  if (missing) return fail(paths, "binary-missing", `cargo build produced no ${missing}`);

  try {
    safeRemove(deps, paths.stagingDir);
    deps.fs.mkdirp(paths.stagingDir);
    for (const name of names) deps.fs.copyFile(join(releaseDir, name), join(paths.stagingDir, name));
  } catch (error) {
    return fail(paths, "install-failed", `staging the binaries failed: ${String(error)}`);
  }

  const verify = await deps.run(join(paths.stagingDir, RUSTC_DRIVER_CLI_BINARY), ["-V"], {
    env,
    cwd: deps.crateDir,
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  const banner = verify.kind === "exited" && verify.status === 0 ? parseRustcDriverVersion(verify.output) : null;
  if (banner?.pin !== deps.pin || banner.sourceHash !== deps.sourceHash) {
    return fail(paths, "banner-mismatch", `built binary banner is not ${deps.pin} ${deps.sourceHash}`);
  }

  try {
    deps.fs.rename(paths.stagingDir, paths.binDir);
  } catch (error) {
    // A concurrent session may have published the same key first.
    if (isInstalled(deps, paths.binDir)) return null;
    return fail(paths, "install-failed", `publishing the build failed: ${String(error)}`);
  }
  return null;
}

function writeLog(deps: RustcDriverBuildDeps, paths: BuildPaths, output: string): void {
  try {
    deps.fs.mkdirp(dirname(paths.logPath));
    deps.fs.writeText(paths.logPath, output);
  } catch {
    // The log is diagnostic only.
  }
}

function safeRemove(deps: RustcDriverBuildDeps, path: string): void {
  try {
    deps.fs.remove(path);
  } catch {
    // Best-effort cleanup.
  }
}

// ---------------------------------------------------------------------------
// sourceHash — byte-for-byte mirror of native/rust-callsites/build_support/source_hash.rs
// ---------------------------------------------------------------------------

const SOURCE_HASH_FILES = ["Cargo.toml", "Cargo.lock", "build.rs", "rust-toolchain.toml"] as const;
const SOURCE_HASH_DIRS = ["build_support", "src"] as const;

export interface RustcDriverSourceFs {
  readFile: (path: string) => Buffer;
  /** Entries of a directory; symlinks resolve to what they point at. */
  listDir: (path: string) => readonly { name: string; isDirectory: boolean; isFile: boolean }[];
}

/**
 * sha256 identity of the crate source: `Cargo.toml`, `Cargo.lock`, `build.rs`,
 * `rust-toolchain.toml` plus every file under `build_support/` and `src/`, sorted bytewise by
 * `/`-separated relative path, each hashed as `<path>\0<length>\0<bytes>`.
 */
export function computeRustCallsitesSourceHash(crateDir: string, fs: RustcDriverSourceFs): string {
  const inputs: string[] = [...SOURCE_HASH_FILES];
  for (const dir of SOURCE_HASH_DIRS) collectFiles(fs, crateDir, dir, inputs);
  inputs.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const hash = createHash("sha256");
  for (const rel of inputs) {
    const bytes = fs.readFile(join(crateDir, rel));
    hash.update(Buffer.from(rel));
    hash.update(Buffer.from([0]));
    hash.update(Buffer.from(String(bytes.length)));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function collectFiles(fs: RustcDriverSourceFs, root: string, rel: string, into: string[]): void {
  for (const entry of fs.listDir(join(root, rel))) {
    const entryRel = `${rel}/${entry.name}`;
    if (entry.isDirectory) collectFiles(fs, root, entryRel, into);
    else if (entry.isFile) into.push(entryRel);
  }
}

// ---------------------------------------------------------------------------
// Host bindings
// ---------------------------------------------------------------------------

export const defaultRustcDriverSourceFs: RustcDriverSourceFs = {
  readFile: (path) => readFileSync(path),
  listDir: (path) =>
    readdirSync(path, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })),
};

export const defaultRustcDriverBuildFs: RustcDriverBuildFs = {
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, "utf8"),
  writeText: (path, content) => {
    writeFileSync(path, content);
  },
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true });
  },
  copyFile: (from, to) => {
    copyFileSync(from, to);
  },
  rename: (from, to) => {
    renameSync(from, to);
  },
  remove: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
};

/** Spawn with merged, bounded output and a hard timeout. Never rejects. */
export async function runRustcDriverBuildCommand(
  command: string,
  args: readonly string[],
  options: RustcDriverSpawnOptions,
): Promise<RustcDriverSpawnOutcome> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      if (output.length < MAX_LOG_CHARS) output += chunk.toString("utf8");
    };
    try {
      const child = spawn(command, [...args], {
        env: options.env,
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", () => {
        clearTimeout(timer);
        resolve({ kind: "spawn-failed", output });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve(timedOut ? { kind: "timed-out", output } : { kind: "exited", status: status ?? 1, output });
      });
    } catch {
      resolve({ kind: "spawn-failed", output });
    }
  });
}
