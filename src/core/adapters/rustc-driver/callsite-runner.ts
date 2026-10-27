/**
 * Runs the rustc call-site driver (`tea-rags-rustc-driver`) over a Rust
 * workspace and hands back the decoded call-site → definition lookup
 * (research/rustc-driver/SPEC.md §2, §8.3, §8.4; bd s3i8m T4).
 *
 * The driver IS `cargo check`: build scripts and proc macros run. It is ON by
 * default whenever discovery finds the driver or the pinned toolchain with
 * rustc-dev; `CODEGRAPH_RUST_DRIVER=off` disables it.
 *
 * Every spawn is forced onto the pinned toolchain (`RUSTUP_TOOLCHAIN`, `RUSTC`,
 * `SYSROOT`, the pin's `bin/` first on `PATH`) whatever the corpus pins, works
 * offline, and writes only under `${dataDir}/rustc-driver/projects/<sha256 of
 * the canonical project root>/` — the user's `target/` is never read or written.
 * That one dir per project holds a persistent `target/` and the run record of
 * one environment: `env.json` (its envKey), `run.json`, `sources.json`,
 * `units/`, `latch.json`. A new envKey drops the record and keeps `target/`
 * (cargo's fingerprints invalidate what the new driver, rustc or Cargo.lock
 * touches). `run.lock` serializes acquisitions of one project across processes.
 * The per-envKey `<64 hex>/` dirs of the earlier layout are swept from the
 * rustc-driver root on every acquisition. A wall and a process-tree RSS budget
 * kill the tree on a breach.
 *
 * Cache: cargo's own fingerprints are the content cache, so an acquisition that
 * spawns (warm ≈ seconds) reads the units `run.json` lists; the driver deletes
 * unit files it no longer lists. `identity` = envKey + digest of the listed
 * unit files' names, sizes and mtimes. A complete previous run (no failed
 * crate, no missing unit, every unit file present) whose `.rs` stamps all still
 * match `sources.json` is served as is (`reused`, same identity) without
 * invoking cargo, whatever the admission.
 *
 * Latch lattice: an environment failure (the driver cannot be built, or every
 * unit failed) is persisted per envKey and answered without spawning until the
 * environment changes; an every-unit-failed latch also records the digest of
 * the `.rs` stamps it failed on and lapses once any source changes (a fixed
 * compile error must not stay latched); a budget breach is not persisted; a per-crate compile
 * failure is reported (`failedCrates`) and not persisted. Units cargo reports
 * but no unit file covers (`missing`) trigger ONE retry with a fresh target dir.
 *
 * Never throws: every outcome is an acquisition status.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ManifestFile,
  RustCallSiteAdmission,
  RustCallSiteDefinition,
  RustCallSiteIndex,
  RustCallSiteSourceConfig,
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
import { DaemonLock } from "../qdrant/embedded/daemon-lock.js";
import { decodeRustcCallSites } from "./callsite-decoder.js";
import {
  computeRustcDriverSourceHash,
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
/** How often a run waiting on the project lock retries it. */
const LOCK_POLL_MS = 1000;

/** The `run.json` / unit-file layout the runner reads (the crate's `CALLSITES_FORMAT`). */
const CALLSITES_FORMAT = 5;
const HOST_COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_CHARS = 4096;
const RUSTC_DRIVER_DIR = "rustc-driver";
const PROJECTS_DIR = "projects";
/** A rustc-driver root entry of the per-envKey layout that preceded `projects/`. */
const LEGACY_ENV_DIR = /^[0-9a-f]{64}$/;
/** `{ envKey }` of the environment the project dir's run record belongs to. */
const ENV_FILE = "env.json";
/** Held for the whole acquisition so two runs on one project never interleave record writes. */
const LOCK_FILE = "run.lock";
const UNITS_DIR = "units";
const LATCH_FILE = "latch.json";
const RUN_FILE = "run.json";
/** The `.rs` stamps the run that wrote `run.json` started from; what a reuse is judged against. */
const SOURCES_FILE = "sources.json";
const CHILD_NAME = "tea-rags-rustc-callsites";
const DISABLED_VALUE = /^(off|0|false|no)$/i;
const OFFLINE_PATTERN =
  /--offline was specified|attempting to make an HTTP request|failed to download|unable to update registry|no matching package named/i;

/**
 * `reused`: cargo did not run and the previous run's units were served: whole
 * when that run was complete and no `.rs` stamp changed since, else (admission
 * refused a spawn) for the files whose stamp still matches. `noCache`: admission
 * refused a spawn and there was no previous run to serve.
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
   * files. `reuseOnly` never builds the driver: the previous run is served for
   * unchanged files, else `noCache`, except for the two spawns
   * {@link acquireRustcCallSites} documents. Absent = spawn.
   */
  admission?: RustCallSiteAdmission;
  /** `never` = cargo never runs, whatever the admission (`RustCallSiteSourceConfig.spawn`). Absent = allowed. */
  spawn?: RustCallSiteSourceConfig["spawn"];
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
    /** Entry names of a directory; none when it is unreadable. */
    listDir: (path: string) => readonly string[];
    stat: (path: string) => { size: number; mtimeMs: number } | undefined;
    listRustSources: (projectRoot: string) => readonly RustSourceStamp[];
    /** Canonical path (symlinks resolved), as cargo reports it in package ids; the input when unresolvable. */
    realPath: (path: string) => string;
  };
  /** Every workspace `Cargo.toml` under the root. */
  readCargoManifests: (projectRoot: string) => readonly ManifestFile[];
  /**
   * Exclusive lock on `lockPath` across processes, waited for up to `waitMs`;
   * resolves to its release, or `undefined` when another holder kept it that long.
   */
  lockRunRecord: (lockPath: string, waitMs: number) => Promise<(() => void) | undefined>;
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
  /** `allUnitsFailed` only: `sourcesDigest` of the stamps the run failed on. */
  sources?: string;
}

/**
 * Acquire the call-site index of `options.projectRoot`. Never throws.
 *
 * Whatever the admission, a complete previous run with unchanged `.rs` stamps is
 * served without cargo (`reused`). A `reuseOnly` admission is upgraded to a
 * spawn in two cases only:
 * - warm + changed: a `run.json` of this envKey exists, the project's `target/` exists on
 *   disk, and a `.rs` file was added, removed or re-stamped since its
 *   `sources.json` (or none was recorded). Cargo's fingerprints keep this an
 *   incremental check (seconds; ~1.5 min when tikv's root crate changed, against
 *   6-11 min cold). Warmth is judged here because only this adapter owns the
 *   target dir; the admission (a share of the project's files) stays the
 *   pass-index domain's call.
 * - failed crates touched: the previous run left failed crates or missing units
 *   and a changed file may fix them. This one may spawn into a cold target dir:
 *   without it those crates would get no rows until the next bulk pass.
 *
 * Otherwise `reuseOnly` serves the previous run for unchanged files, or `noCache`.
 * `options.spawn: "never"` (the working-tree graph build) forbids both upgrades.
 */
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
  sweepLegacyEnvironmentDirs(deps);
  const discovery = deps.discover();
  const unavailable = (): RustcCallSiteAcquisition => ({
    status: "unavailable",
    diagnostics: { ...emptyDiagnostics(), hint: rustcDriverInstallHint(deps.pin) },
  });
  if (!discovery) return unavailable();

  let stamps: readonly RustSourceStamp[] | undefined;
  const sources = (): readonly RustSourceStamp[] => (stamps ??= deps.fs.listRustSources(options.projectRoot));
  let decision: boolean | undefined;
  const neverSpawn = options.spawn === "never";
  const reuseOnly = (): boolean =>
    (decision ??= neverSpawn || options.admission?.(sources().map((stamp) => stamp.relPath)) === "reuseOnly");

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
  const envDir = rustcDriverProjectDir(deps.dataDir, deps.fs.realPath(options.projectRoot));

  const lockPath = join(envDir, LOCK_FILE);
  const release = await deps.lockRunRecord(lockPath, (options.timeoutSec ?? RUSTC_DRIVER_DEFAULT_TIMEOUT_SEC) * 1000);
  if (!release) {
    return {
      status: "failed",
      diagnostics: { ...emptyDiagnostics(), envKey, detail: `another run still holds ${lockPath}` },
    };
  }
  try {
    adoptEnvironment(deps, envDir, envKey);
    return await acquireForEnvironment(deps, options, { driver, envKey, envDir, cargoArgs }, sources, reuseOnly);
  } finally {
    release();
  }
}

interface RustcDriverEnvironment {
  driver: ResolvedDriver;
  envKey: string;
  /** The project dir: the run record of `envKey` and the persistent `target/`. */
  envDir: string;
  cargoArgs: string;
}

/**
 * Points the project dir's run record at `envKey`. A record of another
 * environment (run.json, sources.json, units, latch) is dropped; `target/` is
 * kept, since cargo's own fingerprints invalidate it per unit when the driver,
 * rustc or Cargo.lock changed.
 */
function adoptEnvironment(deps: RustcCallSiteRunnerDeps, envDir: string, envKey: string): void {
  const recorded = parseJson(deps.fs.readText(join(envDir, ENV_FILE)));
  if (isRecord(recorded) && recorded.envKey === envKey) return;
  for (const name of [RUN_FILE, SOURCES_FILE, LATCH_FILE, UNITS_DIR]) deps.fs.remove(join(envDir, name));
  deps.fs.writeTextAtomic(join(envDir, ENV_FILE), JSON.stringify({ envKey }));
}

async function acquireForEnvironment(
  deps: RustcCallSiteRunnerDeps,
  options: RustcCallSiteRunOptions,
  environment: RustcDriverEnvironment,
  sources: () => readonly RustSourceStamp[],
  reuseOnly: () => boolean,
): Promise<RustcCallSiteAcquisition> {
  const { driver, envKey, envDir, cargoArgs } = environment;
  const neverSpawn = options.spawn === "never";
  const latch = readLatch(deps, envDir, sources);
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
  const driverRun = readRunJson(deps, envDir);
  const recorded = readRecordedSources(deps, envDir);
  // No sources.json beside a run.json (a run cut off before recording it) cannot be judged unchanged.
  const sourcesChanged = recorded === undefined || changedSources(recorded, sources()).size > 0;
  if (driverRun && !sourcesChanged && isCompleteRun(driverRun)) {
    const served = decodedAcquisition(deps, envKey, envDir, driverRun, { ...emptyDiagnostics(), envKey });
    if (served.diagnostics.unitCount === driverRun.units.length) return { ...served, status: "reused" };
  }
  if (reuseOnly()) {
    const warm = driverRun !== undefined && deps.fs.stat(join(envDir, "target")) !== undefined;
    const projectRoots = (): readonly string[] => [options.projectRoot, deps.fs.realPath(options.projectRoot)];
    const failedFixable =
      driverRun !== undefined &&
      recorded !== undefined &&
      failedCratesTouched(driverRun, recorded, sources(), projectRoots);
    if (neverSpawn || (!(warm && sourcesChanged) && !failedFixable)) {
      return reusePreviousRun(deps, envKey, envDir, driverRun, recorded, sources());
    }
  }
  return runDriver(deps, options, driver, envKey, envDir, cargoArgs, sources());
}

/** `${dataDir}/rustc-driver/projects/<sha256 of the canonical project root>`. */
function rustcDriverProjectDir(dataDir: string, canonicalProjectRoot: string): string {
  return join(dataDir, RUSTC_DRIVER_DIR, PROJECTS_DIR, sha256(canonicalProjectRoot));
}

/**
 * Removes the per-envKey dirs (`<64 hex>/` at the rustc-driver root) of the
 * layout before one dir per project: nothing reads them any more, and each held
 * a cargo target dir of several GB. Every other entry (`bin/`, `build-logs/`,
 * `build-tmp/`, `projects/`) is left alone. Best-effort: a failed removal is
 * retried on the next acquisition.
 */
function sweepLegacyEnvironmentDirs(deps: RustcCallSiteRunnerDeps): void {
  const root = join(deps.dataDir, RUSTC_DRIVER_DIR);
  for (const name of deps.fs.listDir(root)) {
    if (!LEGACY_ENV_DIR.test(name)) continue;
    try {
      deps.fs.remove(join(root, name));
    } catch {
      // Left for the next acquisition.
    }
  }
}

/** The run left no failed crate and no missing unit: its units cover the whole workspace. */
function isCompleteRun(driverRun: DriverRun): boolean {
  return driverRun.success && driverRun.failed.length === 0 && driverRun.missing === 0;
}

/** `.rs` relPaths added, removed or re-stamped (size or mtime) since `recorded`. */
function changedSources(recorded: RecordedSources, stamps: readonly RustSourceStamp[]): Set<string> {
  const changed = new Set(Object.keys(recorded));
  for (const stamp of stamps) {
    const was = recorded[stamp.relPath];
    if (was?.[0] === stamp.size && was[1] === stamp.mtimeMs) changed.delete(stamp.relPath);
    else changed.add(stamp.relPath);
  }
  return changed;
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
    deps.fs.remove(join(envDir, LATCH_FILE));
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
      const latched = allUnitsFailedLatch(driverRun, tail, options.projectRoot, stamps);
      // An offline-fetch failure is the one cause the user fixes without touching a
      // `.rs` file or Cargo.lock (`cargo fetch`), so no source-keyed latch can lapse
      // on it: answer failed with the hint every run, and let the retry (2-5 s) decide.
      if (!isOfflineFetchFailure(tail)) deps.fs.writeTextAtomic(join(envDir, LATCH_FILE), JSON.stringify(latched));
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
  driverRun: DriverRun | undefined,
  recorded: RecordedSources | undefined,
  stamps: readonly RustSourceStamp[],
): RustcCallSiteAcquisition {
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
  return {
    status: "reused",
    index: servedForUnchanged(decoded.index, unchanged, `${decoded.index.identity}~${sourcesDigest(stamps)}`),
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

/**
 * Whether the previous run left crates without rows that an edit since may have
 * fixed, so a `reuseOnly` acquisition re-runs cargo instead of re-serving them.
 * Needs a `.rs` file added, removed or re-stamped since that run, under the
 * directory of a crate that failed (from its `path+file://` package id). A
 * failure naming no directory (a stderr-only package name) or missing units
 * accept any changed file. A failed crate outside the project (registry, git,
 * or a path dependency outside the root) is fixed by no project edit.
 */
function failedCratesTouched(
  driverRun: DriverRun,
  recorded: RecordedSources,
  stamps: readonly RustSourceStamp[],
  projectRoots: () => readonly string[],
): boolean {
  if (driverRun.failed.length === 0 && driverRun.missing === 0) return false;
  const changed = changedSources(recorded, stamps);
  if (changed.size === 0) return false;
  if (driverRun.missing > 0) return true;
  return driverRun.failed.some((crate) => {
    const crateDir = projectCrateDir(crate.packageId, projectRoots());
    if (crateDir === null) return true;
    if (crateDir === undefined) return false;
    return [...changed].some((relPath) => crateDir === "" || relPath.startsWith(`${crateDir}/`));
  });
}

/**
 * Project-relative directory of a `path+file://` package id (`""` = the root),
 * under the first of `projectRoots` (as given, then canonical: cargo reports the
 * canonical path) that contains it; `undefined` for a crate outside the project;
 * `null` when the id names no directory.
 */
function projectCrateDir(packageId: string, projectRoots: readonly string[]): string | null | undefined {
  if (!packageId.includes("+")) return null;
  if (!packageId.startsWith("path+file://")) return undefined;
  let absoluteDir: string;
  try {
    absoluteDir = fileURLToPath(packageId.slice("path+".length).split("#")[0] ?? "");
  } catch {
    return null;
  }
  for (const projectRoot of projectRoots) {
    const relDir = relative(projectRoot, absoluteDir);
    if (!relDir.startsWith("..") && !isAbsolute(relDir)) return relDir.split(sep).join("/");
  }
  return undefined;
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
    const path = join(envDir, UNITS_DIR, unit.file);
    const text = deps.fs.readText(path);
    if (text === undefined) continue;
    texts.push(text);
    const stat = deps.fs.stat(path);
    stamps.push([unit.file, stat?.size ?? text.length, stat?.mtimeMs ?? 0]);
  }
  stamps.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const identity = `${envKey}:${sha256(JSON.stringify(stamps))}`;
  const index = decodeRustcCallSites(texts, identity, { workspaceCrates: driverRun.units.map((unit) => unit.crate) });
  return {
    status: isCompleteRun(driverRun) ? "ok" : "partial",
    index,
    diagnostics: {
      ...diagnostics,
      unitCount: texts.length,
      failedCrates: driverRun.failed,
      missingUnits: driverRun.missing,
    },
  };
}

function allUnitsFailedLatch(
  driverRun: DriverRun,
  tail: string,
  projectRoot: string,
  stamps: readonly RustSourceStamp[],
): PersistedLatch {
  const detail = driverRun.failed[0]?.firstError ?? `no unit compiled: ${lastLines(tail)}`;
  const sources = sourcesDigest(stamps);
  return isOfflineFetchFailure(tail)
    ? { reason: "allUnitsFailed", detail, hint: rustcDriverOfflineHint(projectRoot), sources }
    : { reason: "allUnitsFailed", detail, sources };
}

/** Cargo failed resolving dependencies under `CARGO_NET_OFFLINE`; `cargo fetch` is the remedy. */
function isOfflineFetchFailure(tail: string): boolean {
  return OFFLINE_PATTERN.test(tail);
}

/** Order-independent digest of the `.rs` stamps (relPath, size, mtimeMs). */
function sourcesDigest(stamps: readonly RustSourceStamp[]): string {
  return sha256(JSON.stringify(stamps.map((stamp) => [stamp.relPath, stamp.size, stamp.mtimeMs]).sort()));
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
    TEA_RAGS_RUSTC_DRIVER_OUT: envDir,
    TEA_RAGS_RUSTC_DRIVER_CARGO_ARGS: cargoArgs,
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

/**
 * The persisted latch, if it still holds. An `allUnitsFailed` latch holds only
 * while the `.rs` stamps match the ones it failed on (a latch written before
 * stamps were recorded never matches); `sources` is listed only when a latch exists.
 */
function readLatch(
  deps: RustcCallSiteRunnerDeps,
  envDir: string,
  sources: () => readonly RustSourceStamp[],
): PersistedLatch | undefined {
  const parsed = parseJson(deps.fs.readText(join(envDir, LATCH_FILE)));
  if (!isRecord(parsed) || typeof parsed.detail !== "string") return undefined;
  if (parsed.reason !== "driverBuild" && parsed.reason !== "allUnitsFailed") return undefined;
  if (parsed.reason === "allUnitsFailed" && parsed.sources !== sourcesDigest(sources())) return undefined;
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
 * `native/tea-rags-rustc-driver` of this checkout or installed package: four levels
 * up from both `src/core/adapters/rustc-driver/` and `build/core/adapters/rustc-driver/`.
 */
export function rustcDriverCrateDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "native", "tea-rags-rustc-driver");
}

/** Runner bound to the real host. */
export function defaultRustcCallSiteRunnerDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RustcCallSiteRunnerDeps {
  const pin = RUSTC_DRIVER_TOOLCHAIN_PIN;
  const dataDir = env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  const crateDir = rustcDriverCrateDir();
  const crateShipped = existsSync(join(crateDir, "Cargo.toml"));
  let sourceHash = "unshipped";
  if (crateShipped) {
    try {
      sourceHash = computeRustcDriverSourceHash(crateDir, defaultRustcDriverSourceFs);
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
      listDir: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return [];
        }
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
      realPath: (path) => {
        try {
          return realpathSync(path);
        } catch {
          return path;
        }
      },
    },
    readCargoManifests: (projectRoot) => readManifestFiles(projectRoot, (fileName) => fileName === "Cargo.toml"),
    lockRunRecord: lockRustcDriverRunRecord,
  };
}

/**
 * `O_EXCL` pid lock file at `lockPath` (a dead holder's lock is taken over),
 * polled until `waitMs` has passed. A lock dir that cannot be created yields a
 * no-op release: there is nothing to serialize when nothing can be written.
 */
export async function lockRustcDriverRunRecord(lockPath: string, waitMs: number): Promise<(() => void) | undefined> {
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    return () => undefined;
  }
  const lock = new DaemonLock();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const held = lock.acquire(lockPath);
    if (held) {
      return () => {
        lock.release(held.fd);
      };
    }
    if (Date.now() >= deadline) return undefined;
    await new Promise((done) => setTimeout(done, Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now()))));
  }
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
