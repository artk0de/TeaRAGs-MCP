/**
 * Runs `rust-analyzer scip` over a Rust project once and hands back the decoded
 * call-site → definition lookup (bd s3i8m.6 R2a). Safe by default:
 *
 * - no-exec settings (build scripts and proc macros off, the build-script
 *   command overridden to `/usr/bin/true`) unless the caller opts into `exec`;
 * - `CARGO_NET_OFFLINE=true`, and `CARGO_TARGET_DIR` under the data dir, so a
 *   run never touches the network nor writes into the corpus;
 * - a wall and a resident-memory budget over the whole child tree — a breach
 *   kills the tree and returns a typed latch, never a throw.
 *
 * A project-pinned toolchain (`rust-toolchain(.toml)`) that rustup has
 * installed becomes the child's `RUSTC`/`RUSTUP_TOOLCHAIN`, so the sysroot
 * rust-analyzer types std against matches the corpus whichever discovery tier
 * found the binary.
 *
 * Cache: `${dataDir}/rust-analyzer/scip/<envKey>/<contentKey>.json` holds the
 * DECODED index. `envKey` digests everything that changes how the project is
 * understood (binary, rustc, Cargo.lock, every Cargo.toml, settings, exec);
 * `contentKey` digests the `.rs` tree listing (path, size, mtime). An
 * environment-level failure writes `<envKey>/latch.json`: later runs in the same
 * environment return the latch without spawning, whatever the content; any
 * environment change lands in another directory and so clears it. A budget
 * breach is NOT persisted — it may pass on the next run.
 *
 * Retention is one index per `envKey`: `<envKey>/latest.json` points at the
 * newest `<contentKey>.json`, and a new write deletes the one it replaces. The
 * cached index records the `[size, mtimeMs]` of every source it was built from,
 * so an `admission` of `reuseOnly` on a content miss serves that newest index
 * PARTIALLY — only the files whose stamp still matches (a changed file's
 * references and the definitions located in it answer null).
 *
 * Every host effect is injected (`RustAnalyzerScipRunnerDeps`);
 * `defaultRustAnalyzerScipRunnerDeps` binds them to node.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ManifestFile, RustAnalyzerScipIndex, RustAnalyzerScipIndexData } from "../../contracts/types/language.js";
import { readManifestFiles } from "../filesystem/dependency-manifests.js";
import {
  sampleProcessTreeRssKb,
  spawnSupervisedChild,
  superviseChild as superviseBudgetedChild,
  supervisedChildInvocation,
  systemSupervisorClock,
  type SupervisedChild,
  type SupervisedChildSpawnOptions,
} from "../process-tree/supervised-child.js";
import {
  readPinnedToolchainChannel,
  runRustAnalyzerHostCommand,
  type RustAnalyzerCommandOutcome,
  type RustAnalyzerExecutable,
} from "./rust-analyzer-executable.js";
import { createRustAnalyzerScipIndex, decodeRustAnalyzerScip } from "./scip-decoder.js";

/** Settings that keep rust-analyzer from executing project code (verified in the s3i8m.6 spike). */
export const RUST_ANALYZER_NO_EXEC_SETTINGS = {
  cargo: { buildScripts: { enable: false, overrideCommand: ["/usr/bin/true"] } },
  procMacro: { enable: false },
} as const;

/** Settings for trusted corpora: build scripts and proc macros run (`CODEGRAPH_RUST_ANALYZER_EXEC`). */
export const RUST_ANALYZER_EXEC_SETTINGS = {
  cargo: { buildScripts: { enable: true } },
  procMacro: { enable: true },
} as const;

/** Budget poll period: wall clock and process-tree RSS are checked this often. */
export const RUST_ANALYZER_SCIP_POLL_MS = 2000;

/** Bump when the cached decoded form changes shape: part of `envKey`. */
const SCIP_CACHE_FORMAT = 2;
const HOST_COMMAND_TIMEOUT_MS = 10_000;
const OUTPUT_TAIL_CHARS = 4096;
const LATCH_FILE = "latch.json";
const LATEST_FILE = "latest.json";
/** `$0` of the watchdog shell the child runs under. */
const SCIP_CHILD_NAME = "tea-rags-ra-scip";

const OFFLINE_PATTERN =
  /--offline was specified|attempting to make an HTTP request|failed to download|unable to update registry|no matching package named|failed to get `[^`]+` as a dependency/i;
const TOOLCHAIN_SKEW_PATTERN = /outdated toolchain|only supports `?\d/i;

export type RustAnalyzerScipLatchReason = "timeout" | "rss" | "offline" | "exit" | "toolchainSkew";

export type RustAnalyzerScipRunOutcome =
  | {
      kind: "indexed";
      index: RustAnalyzerScipIndex;
      cacheHit: boolean;
      /** rust-analyzer reported the toolchain older than it supports; answers may miss std typing. */
      toolchainSkew: boolean;
      /** Present when a stale `latest` index was served partially instead of spawning. */
      reuse?: { servedFiles: number; staleFiles: number };
      /** Measured only when the run spawned. */
      stats?: { wallMs: number; peakRssMb: number; references: number; definitions: number };
    }
  | {
      kind: "latched";
      reason: RustAnalyzerScipLatchReason;
      detail: string;
      /** The command that lifts an `offline` latch. */
      hint?: string;
    }
  /** The content cache missed and `admission` refused a spawn. */
  | { kind: "skipped"; reason: "noBulkNoCache" };

export interface RustAnalyzerScipRunOptions {
  projectRoot: string;
  executable: RustAnalyzerExecutable;
  exec: boolean;
  timeoutSec: number;
  maxRssMb: number;
  numThreads?: number;
  /**
   * Asked only on a content-cache miss, with the project's `.rs` files the
   * content key was built from: `reuseOnly` answers `skipped` instead of
   * spawning. Absent = always spawn.
   */
  admission?: (projectRustRelPaths: readonly string[]) => "spawn" | "reuseOnly";
}

/** A running `rust-analyzer scip` child. */
export type RustAnalyzerScipChild = SupervisedChild;

/** One `.rs` file of the project as the content key sees it. */
export interface RustSourceStamp {
  relPath: string;
  size: number;
  mtimeMs: number;
}

export interface RustAnalyzerScipRunnerDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** `${TEA_RAGS_DATA_DIR:-~/.tea-rags}`. */
  dataDir: string;
  run: (command: string, args: readonly string[], timeoutMs: number) => RustAnalyzerCommandOutcome;
  spawn: (
    command: string,
    args: readonly string[],
    options: { env: Readonly<Record<string, string | undefined>>; onOutput: (chunk: string) => void },
  ) => RustAnalyzerScipChild;
  /** Summed RSS (KiB) of `pid` and its descendants; undefined when unmeasurable. */
  sampleTreeRssKb: (pid: number) => number | undefined;
  clock: { now: () => number; every: (ms: number, tick: () => void) => () => void };
  fs: {
    readBytes: (path: string) => Uint8Array | undefined;
    readText: (path: string) => string | undefined;
    /** tmp + rename, creating parent directories; a failed write is silent. */
    writeTextAtomic: (path: string, text: string) => void;
    remove: (path: string) => void;
    makeTempDir: () => string;
    listRustSources: (projectRoot: string) => readonly RustSourceStamp[];
  };
  /** Every workspace `Cargo.toml` under the root. */
  readCargoManifests: (projectRoot: string) => readonly ManifestFile[];
}

interface CachedScipIndex {
  toolchainSkew: boolean;
  /** `[size, mtimeMs]` of every `.rs` file the index was built from. */
  sources: Record<string, [number, number]>;
  data: RustAnalyzerScipIndexData;
}

interface PersistedLatch {
  reason: RustAnalyzerScipLatchReason;
  detail: string;
  hint?: string;
}

/** The command that makes `cargo metadata` work offline for `projectRoot`. */
export function rustAnalyzerOfflineHint(projectRoot: string): string {
  return `cargo fetch --manifest-path ${join(projectRoot, "Cargo.toml")}`;
}

/** Index `options.projectRoot` (or answer from cache / a persisted latch). Never throws. */
export async function runRustAnalyzerScip(
  options: RustAnalyzerScipRunOptions,
  deps: RustAnalyzerScipRunnerDeps,
): Promise<RustAnalyzerScipRunOutcome> {
  try {
    return await runScip(options, deps);
  } catch (error) {
    return { kind: "latched", reason: "exit", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function runScip(
  options: RustAnalyzerScipRunOptions,
  deps: RustAnalyzerScipRunnerDeps,
): Promise<RustAnalyzerScipRunOutcome> {
  const { projectRoot } = options;
  const toolchain = matchedToolchain(projectRoot, deps);
  const settings = options.exec ? RUST_ANALYZER_EXEC_SETTINGS : RUST_ANALYZER_NO_EXEC_SETTINGS;
  const envKey = environmentKey(options, deps, toolchain.rustc, settings);
  const envDir = join(deps.dataDir, "rust-analyzer", "scip", envKey);

  const latch = readLatch(deps, envDir);
  if (latch) return { kind: "latched", ...latch };

  const stamps = deps.fs.listRustSources(projectRoot);
  const contentKey = sha256(JSON.stringify(sortedStamps(stamps)));
  const identity = `${envKey}:${contentKey}`;
  const cachePath = join(envDir, `${contentKey}.json`);
  const cached = readCache(deps, cachePath);
  if (cached) {
    return {
      kind: "indexed",
      index: createRustAnalyzerScipIndex(cached.data, identity),
      cacheHit: true,
      toolchainSkew: cached.toolchainSkew,
    };
  }
  if (options.admission?.(stamps.map((stamp) => stamp.relPath)) === "reuseOnly") {
    return reusePartial(deps, envDir, envKey, contentKey, stamps);
  }

  const tempDir = deps.fs.makeTempDir();
  try {
    const configPath = join(tempDir, "rust-analyzer.json");
    const outputPath = join(tempDir, "index.scip");
    deps.fs.writeTextAtomic(configPath, JSON.stringify(settings));
    const childEnv: Record<string, string | undefined> = {
      ...deps.env,
      CARGO_NET_OFFLINE: "true",
      CARGO_TARGET_DIR: join(deps.dataDir, "rust-analyzer", "target", envKey),
      ...(toolchain.channel && toolchain.pinnedRustc
        ? { RUSTC: toolchain.pinnedRustc, RUSTUP_TOOLCHAIN: toolchain.channel }
        : {}),
    };
    const args = [
      "scip",
      projectRoot,
      "--output",
      outputPath,
      "--config-path",
      configPath,
      "--exclude-vendored-libraries",
      ...(options.numThreads ? ["--num-threads", String(options.numThreads)] : []),
    ];
    const supervisedRun = await superviseChild(options, deps, args, childEnv);
    if (supervisedRun.breach) {
      return { kind: "latched", reason: supervisedRun.breach.reason, detail: supervisedRun.breach.detail };
    }

    const output = supervisedRun.exitCode === 0 ? deps.fs.readBytes(outputPath) : undefined;
    if (!output) return persistLatch(deps, envDir, failureOf(supervisedRun, projectRoot));

    let data: RustAnalyzerScipIndexData;
    try {
      data = decodeRustAnalyzerScip(output);
    } catch (error) {
      return persistLatch(deps, envDir, {
        reason: "exit",
        detail: `undecodable SCIP output: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    const cachedScipIndex: CachedScipIndex = {
      toolchainSkew: supervisedRun.toolchainSkew,
      sources: Object.fromEntries(stamps.map((stamp) => [stamp.relPath, [stamp.size, stamp.mtimeMs]])),
      data,
    };
    const previousKey = readLatestKey(deps, envDir);
    deps.fs.writeTextAtomic(cachePath, JSON.stringify(cachedScipIndex));
    deps.fs.writeTextAtomic(join(envDir, LATEST_FILE), JSON.stringify({ contentKey }));
    if (previousKey && previousKey !== contentKey) deps.fs.remove(join(envDir, `${previousKey}.json`));
    return {
      kind: "indexed",
      index: createRustAnalyzerScipIndex(data, identity),
      cacheHit: false,
      toolchainSkew: supervisedRun.toolchainSkew,
      stats: {
        wallMs: supervisedRun.wallMs,
        peakRssMb: Math.round(supervisedRun.peakRssKb / 1024),
        references: Object.values(data.references).reduce((sum, triples) => sum + triples.length / 3, 0),
        definitions: Object.keys(data.definitions).length,
      },
    };
  } finally {
    deps.fs.remove(tempDir);
  }
}

/** The newest cached index of this environment, served for the files whose stamp still matches. */
function reusePartial(
  deps: RustAnalyzerScipRunnerDeps,
  envDir: string,
  envKey: string,
  currentContentKey: string,
  stamps: readonly RustSourceStamp[],
): RustAnalyzerScipRunOutcome {
  const latestKey = readLatestKey(deps, envDir);
  const cached = latestKey ? readCache(deps, join(envDir, `${latestKey}.json`)) : undefined;
  if (!latestKey || !cached) return { kind: "skipped", reason: "noBulkNoCache" };
  const current = new Map(stamps.map((stamp) => [stamp.relPath, stamp]));
  const unchanged = (relPath: string): boolean => {
    const was = cached.sources[relPath];
    const now = current.get(relPath);
    return was?.[0] === now?.size && was?.[1] === now?.mtimeMs && was !== undefined;
  };
  const servedFiles = [...current.keys()].filter(unchanged).length;
  return {
    kind: "indexed",
    index: createRustAnalyzerScipIndex(cached.data, `${envKey}:${latestKey}~${currentContentKey}`, unchanged),
    cacheHit: false,
    toolchainSkew: cached.toolchainSkew,
    reuse: { servedFiles, staleFiles: current.size - servedFiles },
  };
}

function readLatestKey(deps: RustAnalyzerScipRunnerDeps, envDir: string): string | undefined {
  const parsed = parseJson(deps.fs.readText(join(envDir, LATEST_FILE)));
  return isRecord(parsed) && typeof parsed.contentKey === "string" && /^[0-9a-f]{64}$/.test(parsed.contentKey)
    ? parsed.contentKey
    : undefined;
}

interface MatchedToolchain {
  channel?: string;
  /** The pinned channel's rustc, when rustup has it installed. */
  pinnedRustc?: string;
  /** The rustc in effect for the child. */
  rustc: string;
}

function matchedToolchain(projectRoot: string, deps: RustAnalyzerScipRunnerDeps): MatchedToolchain {
  const channel = readPinnedToolchainChannel(projectRoot, deps.fs.readText);
  if (!channel) return { rustc: "rustc" };
  const which = deps.run("rustup", ["which", "rustc", "--toolchain", channel], HOST_COMMAND_TIMEOUT_MS);
  const pinnedRustc = which.kind === "ok" ? which.stdout.trim() : "";
  return pinnedRustc ? { channel, pinnedRustc, rustc: pinnedRustc } : { channel, rustc: "rustc" };
}

function environmentKey(
  options: RustAnalyzerScipRunOptions,
  deps: RustAnalyzerScipRunnerDeps,
  rustc: string,
  settings: object,
): string {
  const { executable, projectRoot } = options;
  const rustcVersion = deps.run(rustc, ["-vV"], HOST_COMMAND_TIMEOUT_MS);
  const manifests = [...deps.readCargoManifests(projectRoot)]
    .map((manifest) => [join(manifest.relDir, manifest.fileName), manifest.content] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(
    JSON.stringify([
      SCIP_CACHE_FORMAT,
      [executable.version, executable.commit, executable.date],
      rustcVersion.kind === "ok" ? rustcVersion.stdout : `rustc:${rustcVersion.kind}`,
      deps.fs.readText(join(projectRoot, "Cargo.lock")) ?? null,
      manifests,
      settings,
      options.exec,
    ]),
  );
}

function sortedStamps(stamps: readonly RustSourceStamp[]): [string, number, number][] {
  return stamps
    .map((stamp): [string, number, number] => [stamp.relPath, stamp.size, stamp.mtimeMs])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

interface SupervisedRun {
  exitCode: number | null;
  breach?: { reason: "timeout" | "rss"; detail: string };
  offline: boolean;
  toolchainSkew: boolean;
  outputTail: string;
  wallMs: number;
  peakRssKb: number;
}

async function superviseChild(
  options: RustAnalyzerScipRunOptions,
  deps: RustAnalyzerScipRunnerDeps,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<SupervisedRun> {
  let tail = "";
  let offline = false;
  let toolchainSkew = false;
  const onOutput = (chunk: string): void => {
    // Match over the previous tail + chunk so a pattern split across chunks is still seen.
    const window = tail.slice(-256) + chunk;
    offline ||= OFFLINE_PATTERN.test(window);
    toolchainSkew ||= TOOLCHAIN_SKEW_PATTERN.test(window);
    tail = (tail + chunk).slice(-OUTPUT_TAIL_CHARS);
  };
  const run = await superviseBudgetedChild(
    () => deps.spawn(options.executable.path, args, { env, onOutput }),
    {
      label: "rust-analyzer scip",
      timeoutSec: options.timeoutSec,
      maxRssMb: options.maxRssMb,
      pollMs: RUST_ANALYZER_SCIP_POLL_MS,
    },
    deps,
  );
  return { ...run, offline, toolchainSkew, outputTail: tail };
}

function failureOf(supervisedRun: SupervisedRun, projectRoot: string): PersistedLatch {
  const detail = `rust-analyzer scip exited ${supervisedRun.exitCode ?? "by signal"}: ${lastLines(supervisedRun.outputTail)}`;
  if (supervisedRun.offline) return { reason: "offline", detail, hint: rustAnalyzerOfflineHint(projectRoot) };
  if (supervisedRun.toolchainSkew) return { reason: "toolchainSkew", detail };
  return { reason: "exit", detail };
}

function lastLines(text: string): string {
  return text.trim().split(/\r?\n/).slice(-3).join(" | ");
}

function persistLatch(
  deps: RustAnalyzerScipRunnerDeps,
  envDir: string,
  latch: PersistedLatch,
): RustAnalyzerScipRunOutcome {
  deps.fs.writeTextAtomic(join(envDir, LATCH_FILE), JSON.stringify(latch));
  return { kind: "latched", ...latch };
}

function readLatch(deps: RustAnalyzerScipRunnerDeps, envDir: string): PersistedLatch | undefined {
  const parsed = parseJson(deps.fs.readText(join(envDir, LATCH_FILE)));
  if (!isRecord(parsed) || typeof parsed.reason !== "string" || typeof parsed.detail !== "string") return undefined;
  return parsed as unknown as PersistedLatch;
}

function readCache(deps: RustAnalyzerScipRunnerDeps, path: string): CachedScipIndex | undefined {
  const parsed = parseJson(deps.fs.readText(path));
  if (!isRecord(parsed) || typeof parsed.toolchainSkew !== "boolean" || !isRecord(parsed.data)) return undefined;
  if (!isRecord(parsed.sources)) return undefined;
  const { data } = parsed;
  if (!Array.isArray(data.symbols) || !isRecord(data.references) || !isRecord(data.definitions)) return undefined;
  return parsed as unknown as CachedScipIndex;
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

/** Directories never holding project sources the content key should see. */
const SKIPPED_SOURCE_DIRS = new Set(["target", "node_modules"]);

/** Runner bound to the real host. */
export function defaultRustAnalyzerScipRunnerDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RustAnalyzerScipRunnerDeps {
  return {
    env,
    dataDir: env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"),
    run: runRustAnalyzerHostCommand,
    spawn: spawnScipChild,
    sampleTreeRssKb: sampleProcessTreeRssKb,
    clock: systemSupervisorClock,
    fs: {
      readBytes: (path) => {
        try {
          return readFileSync(path);
        } catch {
          return undefined;
        }
      },
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
      makeTempDir: () => mkdtempSync(join(tmpdir(), "tea-rags-ra-scip-")),
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

/** How the `rust-analyzer scip` child is launched (see `supervisedChildInvocation`). */
export function scipChildInvocation(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
): { command: string; args: readonly string[]; watchdog: boolean } {
  return supervisedChildInvocation(platform, command, args, SCIP_CHILD_NAME);
}

function spawnScipChild(
  command: string,
  args: readonly string[],
  options: SupervisedChildSpawnOptions,
): RustAnalyzerScipChild {
  return spawnSupervisedChild(command, args, options, SCIP_CHILD_NAME);
}

/** Every `.rs` file under the root, skipping `target/`, `node_modules/` and dot-directories. */
function listRustSources(projectRoot: string): RustSourceStamp[] {
  const stamps: RustSourceStamp[] = [];
  const walk = (dir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIPPED_SOURCE_DIRS.has(entry.name)) walk(join(dir, entry.name), relPath);
      } else if (entry.isFile() && entry.name.endsWith(".rs")) {
        try {
          const stat = statSync(join(dir, entry.name));
          stamps.push({ relPath, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // vanished between listing and stat: not part of the tree
        }
      }
    }
  };
  walk(projectRoot, "");
  return stamps;
}
