/**
 * Runs the rustc call-site driver (`tearags-rust-callsites`) over a Rust
 * workspace and hands back the decoded call-site → definition lookup
 * (research/rustc-driver/SPEC.md §2, §8.3, §8.4; bd s3i8m T4).
 *
 * The driver IS `cargo check`: build scripts and proc macros run. It is ON by
 * default whenever discovery finds the driver or the pinned toolchain with
 * rustc-dev; `CODEGRAPH_RUST_DRIVER=off` disables it.
 *
 * Every spawn is forced onto the pinned toolchain (`RUSTUP_TOOLCHAIN`, `RUSTC`,
 * `SYSROOT`, the pin's `bin/` first on `PATH`) whatever the corpus pins, works
 * offline, and writes only under `${dataDir}/rustc-driver/<envKey>/`
 * (`target/`, `units/`, `run.json`, `latch.json`) — the user's `target/` is
 * never read or written. A wall and a process-tree RSS budget kill the tree on
 * a breach.
 *
 * Cache: cargo's own fingerprints are the content cache, so every acquisition
 * spawns (warm ≈ seconds) and reads the units `run.json` lists; the driver
 * deletes unit files it no longer lists. `identity` = envKey + digest of the
 * listed unit files' names, sizes and mtimes.
 *
 * Latch lattice: an environment failure (the driver cannot be built, or every
 * unit failed) is persisted per envKey and answered without spawning until the
 * environment changes; a budget breach is not persisted; a per-crate compile
 * failure is reported (`failedCrates`) and not persisted. Units cargo reports
 * but no unit file covers (`missing`) trigger ONE retry with a fresh target dir.
 *
 * Never throws: every outcome is an acquisition status.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ManifestFile,
  RustCallSiteAdmission,
  RustCallSiteDefinition,
  RustCallSiteIndex,
} from "../../contracts/types/language.js";
import { readManifestFiles } from "../filesystem/dependency-manifests.js";
import { listRustSources, type RustSourceStamp } from "../filesystem/rust-sources.js";
import {
  sampleProcessTreeRssKb,
  spawnSupervisedChild,
  superviseChild,
  systemSupervisorClock,
  type SupervisedChild,
  type SupervisedChildBreachReason,
  type SupervisedChildHost,
  type SupervisedChildSpawnOptions,
} from "../process-tree/supervised-child.js";
import { decodeRustcCallSites } from "./callsite-decoder.js";
import {
  computeRustCallsitesSourceHash,
  defaultRustcDriverBuildFs,
  defaultRustcDriverSourceFs,
  ensureRustcDriverBuilt,
  runRustcDriverBuildCommand,
  rustcDriverBuildEnv,
  type RustcDriverBuildResult,
} from "./driver-build.js";
import {
  defaultRustcDriverDiscoveryDeps,
  discoverRustcDriver,
  runRustcDriverHostCommand,
  rustcDriverInstallHint,
  type RustcDriverBuildable,
  type RustcDriverCommandOutcome,
  type RustcDriverDiscovery,
} from "./executable.js";
import { RUSTC_DRIVER_TOOLCHAIN_PIN } from "./pin.js";

/** Disables the driver when set to `off` (also `0` / `false` / `no`). */
export const RUSTC_DRIVER_ENABLE_ENV = "CODEGRAPH_RUST_DRIVER";
/** Parallel rustc processes (`CARGO_BUILD_JOBS`); default `max(1, cores / 2)`. */
export const RUSTC_DRIVER_JOBS_ENV = "CODEGRAPH_RUST_DRIVER_JOBS";
/** Target selection when the caller passes none; the driver always adds `--keep-going`. */
export const RUSTC_DRIVER_DEFAULT_CARGO_ARGS = "--workspace --all-targets";
export const RUSTC_DRIVER_DEFAULT_TIMEOUT_SEC = 3600;
export const RUSTC_DRIVER_DEFAULT_MAX_RSS_MB = 12_288;
/** Budget poll period. */
export const RUSTC_DRIVER_POLL_MS = 2000;

/** The `run.json` / unit-file layout the runner reads (the crate's `CALLSITES_FORMAT`). */
const CALLSITES_FORMAT = 5;
const HOST_COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_CHARS = 4096;
const LATCH_FILE = "latch.json";
const RUN_FILE = "run.json";
/** The `.rs` stamps the run that wrote `run.json` started from; what a reuse is judged against. */
const SOURCES_FILE = "sources.json";
const CHILD_NAME = "tea-rags-rustc-callsites";
const DISABLED_VALUE = /^(off|0|false|no)$/i;
const OFFLINE_PATTERN =
  /--offline was specified|attempting to make an HTTP request|failed to download|unable to update registry|no matching package named/i;

/**
 * `reused`: admission refused a spawn and the previous run's units were served
 * for the files whose stamp still matches. `noCache`: admission refused a spawn
 * and there was no previous run to serve.
 */
export type RustcCallSiteAcquisitionStatus =
  | "ok"
  | "partial"
  | "reused"
  | "noCache"
  | "unavailable"
  | "disabled"
  | "failed";

/** Environment failures persisted per envKey. */
export type RustcCallSiteLatchReason = "driverBuild" | "allUnitsFailed";

/** A crate target that failed to compile under the pin: its sites get no rows. */
export interface RustcCallSiteFailedCrate {
  packageId: string;
  target: string;
  firstError: string;
}

export interface RustcCallSiteDiagnostics {
  /** True when `cargo check` ran this acquisition: build scripts and proc macros executed. */
  ranCargoCheck: boolean;
  /** Unit files the index was decoded from. */
  unitCount: number;
  failedCrates: RustcCallSiteFailedCrate[];
  /** Workspace units cargo reported that no unit file covers, after the retry. */
  missingUnits: number;
  /** A fresh-target retry ran because units were missing. */
  retried: boolean;
  /** Wall time of every spawn of this acquisition. */
  wallMs: number;
  envKey?: string;
  latched?: { reason: RustcCallSiteLatchReason; detail: string };
  budget?: { reason: SupervisedChildBreachReason; detail: string };
  /** What the user can do: install the toolchain, or fetch dependencies. */
  hint?: string;
  /** Why a `failed` acquisition that is neither latched nor a budget breach failed. */
  detail?: string;
}

export interface RustcCallSiteAcquisition {
  status: RustcCallSiteAcquisitionStatus;
  /** Present for `ok`, `partial` and `reused`. */
  index?: RustCallSiteIndex;
  diagnostics: RustcCallSiteDiagnostics;
}

export interface RustcCallSiteRunOptions {
  /** Workspace root: the driver's cwd. */
  projectRoot: string;
  /** Whitespace-split cargo target selection; part of envKey. */
  cargoArgs?: string;
  timeoutSec?: number;
  maxRssMb?: number;
  /**
   * Whether this acquisition may run cargo, decided over the project's `.rs`
   * files. `reuseOnly` never builds the driver nor spawns it: the previous
   * run is served for unchanged files, else `noCache`. Absent = spawn.
   */
  admission?: RustCallSiteAdmission;
}

export interface RustcCallSiteRunnerDeps extends SupervisedChildHost {
  env: Readonly<Record<string, string | undefined>>;
  /** `${TEA_RAGS_DATA_DIR:-~/.tea-rags}`. */
  dataDir: string;
  /** Toolchain channel every spawn is forced onto. */
  pin: string;
  cpuCount: number;
  discover: () => RustcDriverDiscovery | null;
  buildDriver: (buildable: RustcDriverBuildable) => Promise<RustcDriverBuildResult>;
  run: (command: string, args: readonly string[], timeoutMs: number) => RustcDriverCommandOutcome;
  spawn: (command: string, args: readonly string[], options: SupervisedChildSpawnOptions) => SupervisedChild;
  fs: {
    readText: (path: string) => string | undefined;
    /** tmp + rename, creating parent directories; a failed write is silent. */
    writeTextAtomic: (path: string, text: string) => void;
    remove: (path: string) => void;
    stat: (path: string) => { size: number; mtimeMs: number } | undefined;
    listRustSources: (projectRoot: string) => readonly RustSourceStamp[];
  };
  /** Every workspace `Cargo.toml` under the root. */
  readCargoManifests: (projectRoot: string) => readonly ManifestFile[];
}

interface ResolvedDriver {
  binaryPath: string;
  sysroot: string;
}

interface RunJsonUnit {
  file: string;
  crate: string;
}

interface DriverRun {
  success: boolean;
  units: RunJsonUnit[];
  missing: number;
  failed: RustcCallSiteFailedCrate[];
}

interface PersistedLatch {
  reason: RustcCallSiteLatchReason;
  detail: string;
  hint?: string;
}

/** Acquire the call-site index of `options.projectRoot`. Never throws. */
export async function acquireRustcCallSites(
  deps: RustcCallSiteRunnerDeps,
  options: RustcCallSiteRunOptions,
): Promise<RustcCallSiteAcquisition> {
  if (DISABLED_VALUE.test(deps.env[RUSTC_DRIVER_ENABLE_ENV]?.trim() ?? "")) {
    return { status: "disabled", diagnostics: emptyDiagnostics() };
  }
  try {
    return await acquire(deps, options);
  } catch (error) {
    return {
      status: "failed",
      diagnostics: { ...emptyDiagnostics(), detail: error instanceof Error ? error.message : String(error) },
    };
  }
}

async function acquire(
  deps: RustcCallSiteRunnerDeps,
  options: RustcCallSiteRunOptions,
): Promise<RustcCallSiteAcquisition> {
  const discovery = deps.discover();
  const unavailable = (): RustcCallSiteAcquisition => ({
    status: "unavailable",
    diagnostics: { ...emptyDiagnostics(), hint: rustcDriverInstallHint(deps.pin) },
  });
  if (!discovery) return unavailable();

  let stamps: readonly RustSourceStamp[] | undefined;
  const sources = (): readonly RustSourceStamp[] => (stamps ??= deps.fs.listRustSources(options.projectRoot));
  let decision: boolean | undefined;
  const reuseOnly = (): boolean =>
    (decision ??= options.admission?.(sources().map((stamp) => stamp.relPath)) === "reuseOnly");

  let driver: ResolvedDriver;
  if (discovery.kind === "buildable") {
    // Building the driver is a cargo build: never under reuseOnly. No built driver ⇒ no earlier run.
    if (reuseOnly()) return { status: "noCache", diagnostics: emptyDiagnostics() };
    const built = await deps.buildDriver(discovery);
    if (!built.ok) {
      return {
        status: "failed",
        diagnostics: { ...emptyDiagnostics(), latched: { reason: "driverBuild", detail: built.detail } },
      };
    }
    driver = { binaryPath: built.binaryPath, sysroot: discovery.sysroot };
  } else {
    const sysroot = pinSysroot(deps);
    if (!sysroot) return unavailable();
    driver = { binaryPath: discovery.path, sysroot };
  }

  const banner = deps.run(driver.binaryPath, ["-V"], HOST_COMMAND_TIMEOUT_MS);
  if (banner.kind !== "ok") {
    return { status: "failed", diagnostics: { ...emptyDiagnostics(), detail: `${driver.binaryPath} -V failed` } };
  }
  const cargoArgs = options.cargoArgs ?? RUSTC_DRIVER_DEFAULT_CARGO_ARGS;
  const envKey = environmentKey(deps, options.projectRoot, driver, banner.stdout.trim(), cargoArgs);
  const envDir = join(deps.dataDir, "rustc-driver", envKey);

  const latch = readLatch(deps, envDir);
  if (latch) {
    return {
      status: "failed",
      diagnostics: {
        ...emptyDiagnostics(),
        envKey,
        latched: { reason: latch.reason, detail: latch.detail },
        ...(latch.hint ? { hint: latch.hint } : {}),
      },
    };
  }
  if (reuseOnly()) return reusePreviousRun(deps, envKey, envDir, sources());
  return runDriver(deps, options, driver, envKey, envDir, cargoArgs, sources());
}

async function runDriver(
  deps: RustcCallSiteRunnerDeps,
  options: RustcCallSiteRunOptions,
  driver: ResolvedDriver,
  envKey: string,
  envDir: string,
  cargoArgs: string,
  stamps: readonly RustSourceStamp[],
): Promise<RustcCallSiteAcquisition> {
  const targetDir = join(envDir, "target");
  const env = childEnv(deps, driver, envDir, targetDir, cargoArgs);
  const base = { ...emptyDiagnostics(), ranCargoCheck: true, envKey };
  let wallMs = 0;
  let retried = false;

  for (;;) {
    let tail = "";
    const onOutput = (chunk: string): void => {
      tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
    };
    // A run.json left by an earlier run must not be mistaken for this one's,
    // nor its sources.json paired with this one's run.json.
    deps.fs.remove(join(envDir, RUN_FILE));
    deps.fs.remove(join(envDir, SOURCES_FILE));
    const supervised = await superviseChild(
      () => deps.spawn(driver.binaryPath, [], { env, onOutput, cwd: options.projectRoot }),
      {
        label: "rustc call-site driver",
        timeoutSec: options.timeoutSec ?? RUSTC_DRIVER_DEFAULT_TIMEOUT_SEC,
        maxRssMb: options.maxRssMb ?? RUSTC_DRIVER_DEFAULT_MAX_RSS_MB,
        pollMs: RUSTC_DRIVER_POLL_MS,
      },
      deps,
    );
    wallMs += supervised.wallMs;
    const diagnostics = { ...base, wallMs, retried };
    if (supervised.breach) return { status: "failed", diagnostics: { ...diagnostics, budget: supervised.breach } };

    const driverRun = readRunJson(deps, envDir);
    if (!driverRun) {
      const detail = `driver exited ${supervised.exitCode ?? "by signal"} without ${RUN_FILE}: ${lastLines(tail)}`;
      return { status: "failed", diagnostics: { ...diagnostics, detail } };
    }
    if (driverRun.missing > 0 && !retried) {
      retried = true;
      deps.fs.remove(targetDir);
      continue;
    }
    if (driverRun.units.length === 0 && !driverRun.success) {
      const latched = allUnitsFailedLatch(driverRun, tail, options.projectRoot);
      deps.fs.writeTextAtomic(join(envDir, LATCH_FILE), JSON.stringify(latched));
      return {
        status: "failed",
        diagnostics: {
          ...diagnostics,
          failedCrates: driverRun.failed,
          latched: { reason: latched.reason, detail: latched.detail },
          ...(latched.hint ? { hint: latched.hint } : {}),
        },
      };
    }
    const recorded: RecordedSources = Object.fromEntries(
      stamps.map((stamp) => [stamp.relPath, [stamp.size, stamp.mtimeMs]]),
    );
    deps.fs.writeTextAtomic(join(envDir, SOURCES_FILE), JSON.stringify(recorded));
    return decodedAcquisition(deps, envKey, envDir, driverRun, diagnostics);
  }
}

/** relPath → `[size, mtimeMs]` of every `.rs` file the run started from. */
type RecordedSources = Record<string, readonly [number, number]>;

/**
 * The previous run of this environment, served for the files whose stamp
 * still matches: a site in a changed file, and a definition located in one,
 * answer null. No previous run ⇒ `noCache`. Spawns nothing.
 */
function reusePreviousRun(
  deps: RustcCallSiteRunnerDeps,
  envKey: string,
  envDir: string,
  stamps: readonly RustSourceStamp[],
): RustcCallSiteAcquisition {
  const driverRun = readRunJson(deps, envDir);
  const recorded = readRecordedSources(deps, envDir);
  if (!driverRun || !recorded || driverRun.units.length === 0) {
    return { status: "noCache", diagnostics: { ...emptyDiagnostics(), envKey } };
  }
  const decoded = decodedAcquisition(deps, envKey, envDir, driverRun, { ...emptyDiagnostics(), envKey });
  if (!decoded.index) return { status: "noCache", diagnostics: decoded.diagnostics };
  const current = new Map(stamps.map((stamp) => [stamp.relPath, stamp]));
  const unchanged = (relPath: string): boolean => {
    const was = recorded[relPath];
    const now = current.get(relPath);
    return was !== undefined && was[0] === now?.size && was[1] === now.mtimeMs;
  };
  const contentKey = sha256(JSON.stringify(stamps.map((stamp) => [stamp.relPath, stamp.size, stamp.mtimeMs]).sort()));
  return {
    status: "reused",
    index: servedForUnchanged(decoded.index, unchanged, `${decoded.index.identity}~${contentKey}`),
    diagnostics: decoded.diagnostics,
  };
}

function servedForUnchanged(
  index: RustCallSiteIndex,
  unchanged: (relPath: string) => boolean,
  identity: string,
): RustCallSiteIndex {
  return {
    identity,
    definitionAt: (relPath, line, utf16Col): RustCallSiteDefinition | null => {
      if (!unchanged(relPath)) return null;
      const definition = index.definitionAt(relPath, line, utf16Col);
      if (definition?.relPath !== undefined && !unchanged(definition.relPath)) return null;
      return definition;
    },
  };
}

function readRecordedSources(deps: RustcCallSiteRunnerDeps, envDir: string): RecordedSources | undefined {
  const text = deps.fs.readText(join(envDir, SOURCES_FILE));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as RecordedSources) : undefined;
  } catch {
    return undefined;
  }
}

function decodedAcquisition(
  deps: RustcCallSiteRunnerDeps,
  envKey: string,
  envDir: string,
  driverRun: DriverRun,
  diagnostics: RustcCallSiteDiagnostics,
): RustcCallSiteAcquisition {
  const texts: string[] = [];
  const stamps: [string, number, number][] = [];
  for (const unit of driverRun.units) {
    const path = join(envDir, "units", unit.file);
    const text = deps.fs.readText(path);
    if (text === undefined) continue;
    texts.push(text);
    const stat = deps.fs.stat(path);
    stamps.push([unit.file, stat?.size ?? text.length, stat?.mtimeMs ?? 0]);
  }
  stamps.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const identity = `${envKey}:${sha256(JSON.stringify(stamps))}`;
  const index = decodeRustcCallSites(texts, identity, { workspaceCrates: driverRun.units.map((unit) => unit.crate) });
  const complete = driverRun.success && driverRun.failed.length === 0 && driverRun.missing === 0;
  return {
    status: complete ? "ok" : "partial",
    index,
    diagnostics: {
      ...diagnostics,
      unitCount: texts.length,
      failedCrates: driverRun.failed,
      missingUnits: driverRun.missing,
    },
  };
}

function allUnitsFailedLatch(driverRun: DriverRun, tail: string, projectRoot: string): PersistedLatch {
  const detail = driverRun.failed[0]?.firstError ?? `no unit compiled: ${lastLines(tail)}`;
  return OFFLINE_PATTERN.test(tail)
    ? { reason: "allUnitsFailed", detail, hint: rustcDriverOfflineHint(projectRoot) }
    : { reason: "allUnitsFailed", detail };
}

/** The command that makes the offline `cargo check` find every dependency. */
export function rustcDriverOfflineHint(projectRoot: string): string {
  return `cargo fetch --manifest-path ${join(projectRoot, "Cargo.toml")}`;
}

function childEnv(
  deps: RustcCallSiteRunnerDeps,
  driver: ResolvedDriver,
  envDir: string,
  targetDir: string,
  cargoArgs: string,
): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = { ...deps.env };
  // A wrapper would replace the driver; a target-dir override would point into the user's tree.
  for (const name of [
    "RUSTC_WRAPPER",
    "RUSTC_WORKSPACE_WRAPPER",
    "CARGO_BUILD_TARGET_DIR",
    "CARGO_BUILD_RUSTC_WRAPPER",
  ]) {
    delete inherited[name];
  }
  return {
    ...rustcDriverBuildEnv(inherited, deps.pin, driver.sysroot),
    SYSROOT: driver.sysroot,
    CARGO_TARGET_DIR: targetDir,
    TEARAGS_CALLSITES_OUT: envDir,
    TEARAGS_CALLSITES_CARGO_ARGS: cargoArgs,
    CARGO_NET_OFFLINE: "true",
    CMAKE_POLICY_VERSION_MINIMUM: "3.5",
    CARGO_BUILD_JOBS: String(jobsOf(deps)),
  };
}

function jobsOf(deps: RustcCallSiteRunnerDeps): number {
  const explicit = Number.parseInt(deps.env[RUSTC_DRIVER_JOBS_ENV] ?? "", 10);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return Math.max(1, Math.floor(deps.cpuCount / 2));
}

/** The pinned toolchain's sysroot, from rustup. */
function pinSysroot(deps: RustcCallSiteRunnerDeps): string | undefined {
  const which = deps.run("rustup", ["which", "--toolchain", deps.pin, "rustc"], HOST_COMMAND_TIMEOUT_MS);
  const rustc = which.kind === "ok" ? which.stdout.trim() : "";
  return rustc ? dirname(dirname(rustc)) : undefined;
}

function environmentKey(
  deps: RustcCallSiteRunnerDeps,
  projectRoot: string,
  driver: ResolvedDriver,
  banner: string,
  cargoArgs: string,
): string {
  const rustcVersion = deps.run(join(driver.sysroot, "bin", "rustc"), ["-vV"], HOST_COMMAND_TIMEOUT_MS);
  const manifests = [...deps.readCargoManifests(projectRoot)]
    .map((manifest) => [join(manifest.relDir, manifest.fileName), manifest.content] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(
    JSON.stringify([
      CALLSITES_FORMAT,
      banner,
      rustcVersion.kind === "ok" ? rustcVersion.stdout : `rustc:${rustcVersion.kind}`,
      deps.fs.readText(join(projectRoot, "Cargo.lock")) ?? null,
      manifests,
      cargoArgs,
    ]),
  );
}

function readRunJson(deps: RustcCallSiteRunnerDeps, envDir: string): DriverRun | undefined {
  const parsed = parseJson(deps.fs.readText(join(envDir, RUN_FILE)));
  if (!isRecord(parsed) || !Array.isArray(parsed.units)) return undefined;
  const units = parsed.units
    .filter(isRecord)
    .filter((unit) => typeof unit.file === "string")
    .map((unit) => ({ file: String(unit.file), crate: typeof unit.crate === "string" ? unit.crate : "" }));
  const failed = (Array.isArray(parsed.failed) ? parsed.failed : []).filter(isRecord).map((entry) => ({
    // A failure cargo reported only on stderr (a build script that failed to run) carries the
    // package name instead: cargo prints no package id there.
    packageId:
      typeof entry.packageId === "string" ? entry.packageId : typeof entry.package === "string" ? entry.package : "",
    target: typeof entry.target === "string" ? entry.target : "",
    firstError: typeof entry.firstError === "string" ? entry.firstError : "",
  }));
  return {
    success: parsed.success === true,
    units,
    missing: Array.isArray(parsed.missing) ? parsed.missing.length : 0,
    failed,
  };
}

function readLatch(deps: RustcCallSiteRunnerDeps, envDir: string): PersistedLatch | undefined {
  const parsed = parseJson(deps.fs.readText(join(envDir, LATCH_FILE)));
  if (!isRecord(parsed) || typeof parsed.detail !== "string") return undefined;
  if (parsed.reason !== "driverBuild" && parsed.reason !== "allUnitsFailed") return undefined;
  return {
    reason: parsed.reason,
    detail: parsed.detail,
    ...(typeof parsed.hint === "string" ? { hint: parsed.hint } : {}),
  };
}

function emptyDiagnostics(): RustcCallSiteDiagnostics {
  return { ranCargoCheck: false, unitCount: 0, failedCrates: [], missingUnits: 0, retried: false, wallMs: 0 };
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(" | ");
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Host bindings
// ---------------------------------------------------------------------------

/**
 * `native/rust-callsites` of this checkout or installed package: four levels
 * up from both `src/core/adapters/rustc-driver/` and `build/core/adapters/rustc-driver/`.
 */
export function rustCallsitesCrateDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "native", "rust-callsites");
}

/** Runner bound to the real host. */
export function defaultRustcCallSiteRunnerDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RustcCallSiteRunnerDeps {
  const pin = RUSTC_DRIVER_TOOLCHAIN_PIN;
  const dataDir = env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  const crateDir = rustCallsitesCrateDir();
  const crateShipped = existsSync(join(crateDir, "Cargo.toml"));
  let sourceHash = "unshipped";
  if (crateShipped) {
    try {
      sourceHash = computeRustCallsitesSourceHash(crateDir, defaultRustcDriverSourceFs);
    } catch {
      // An unreadable crate cannot be built; a prebuilt driver is still found by -V.
    }
  }
  return {
    env,
    dataDir,
    pin,
    cpuCount: availableParallelism(),
    discover: () => discoverRustcDriver(defaultRustcDriverDiscoveryDeps(pin, sourceHash, env)),
    buildDriver: async (buildable) =>
      crateShipped
        ? ensureRustcDriverBuilt(
            {
              crateDir,
              pin,
              sourceHash,
              dataDir,
              env,
              run: runRustcDriverBuildCommand,
              fs: defaultRustcDriverBuildFs,
            },
            buildable,
          )
        : {
            ok: false,
            reason: "build-failed",
            detail: `driver crate not shipped at ${crateDir}`,
            logPath: "",
          },
    run: runRustcDriverHostCommand,
    spawn: (command, args, options) => spawnSupervisedChild(command, args, options, CHILD_NAME),
    sampleTreeRssKb: sampleProcessTreeRssKb,
    clock: systemSupervisorClock,
    fs: {
      readText: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      },
      writeTextAtomic,
      remove: (path) => {
        rmSync(path, { recursive: true, force: true });
      },
      stat: (path) => {
        try {
          const stat = statSync(path);
          return { size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return undefined;
        }
      },
      listRustSources,
    },
    readCargoManifests: (projectRoot) => readManifestFiles(projectRoot, (fileName) => fileName === "Cargo.toml"),
  };
}

function writeTextAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
  }
}
