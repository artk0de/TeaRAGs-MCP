/**
 * Which rust-analyzer binary the Rust codegraph's last resolution slot runs
 * (bd s3i8m.6). Discovery mirrors `adapters/vcs/git/git-executable.ts`: a
 * candidate is usable only when RUNNING `<candidate> --version` answers a
 * parseable banner — never by `existsSync`, because the rustup proxy stub
 * exists on PATH for every rustup user and still fails when the component is
 * not installed.
 *
 * Order (first usable candidate wins):
 *   1. `CODEGRAPH_RUST_ANALYZER_PATH` — this exact name, no alias.
 *   2. `rust-analyzer` on PATH; the rustup proxy is followed through
 *      `rustup which rust-analyzer` and rejected when that fails.
 *   3. rustup: `rustup which rust-analyzer --toolchain <project channel>`, then
 *      `${RUSTUP_HOME:-~/.rustup}/toolchains/* /bin`, project channel first.
 *   4. Homebrew: `/opt/homebrew/bin`, `/usr/local/bin`.
 *   5. asdf: `${ASDF_DATA_DIR:-~/.asdf}/shims`, then `installs/rust/* /bin`.
 *
 * Unlike the git probe, a timeout IS a verdict here: nothing rides on a slow
 * rust-analyzer except the optional last chain slot, so the next tier is tried.
 *
 * Host access (process spawn, filesystem, env) is injected so the order is
 * testable without a real toolchain; `defaultRustAnalyzerDiscoveryDeps` binds
 * it to node.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

/** Env var naming an explicit binary. The ONLY spelling read. */
export const RUST_ANALYZER_PATH_ENV = "CODEGRAPH_RUST_ANALYZER_PATH";

/** `--version` probe window per candidate. */
export const RUST_ANALYZER_VERSION_TIMEOUT_MS = 5000;

const BINARY = "rust-analyzer";
const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

/** Which discovery tier produced the binary. */
export type RustAnalyzerDiscoveryTier = "env" | "path" | "rustup" | "homebrew" | "asdf";

/** The parsed `rust-analyzer <ver> (<sha> <YYYY-MM-DD>)` banner. */
export interface RustAnalyzerVersion {
  version: string;
  commit: string;
  date: string;
}

/** A binary that answered `--version`, with where it came from. */
export interface RustAnalyzerExecutable extends RustAnalyzerVersion {
  path: string;
  tier: RustAnalyzerDiscoveryTier;
  /** Project-pinned rustup channel the binary was resolved for, when one was. */
  toolchain?: string;
}

/** Outcome of running one host command. */
export type RustAnalyzerCommandOutcome = { kind: "ok"; stdout: string } | { kind: "failed" } | { kind: "timed-out" };

export interface RustAnalyzerDiscoveryDeps {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** Project root whose `rust-toolchain(.toml)` pins the rustup channel. */
  projectRoot?: string;
  run: (command: string, args: readonly string[], timeoutMs: number) => RustAnalyzerCommandOutcome;
  fs: {
    exists: (path: string) => boolean;
    readFile: (path: string) => string | undefined;
    listDir: (path: string) => readonly string[];
    realPath: (path: string) => string;
  };
}

const BANNER = /^rust-analyzer\s+(\S+)\s+\((\S+)\s+(\d{4}-\d{2}-\d{2})\)/;

/** Parse a `--version` banner; null for anything that is not one. */
export function parseRustAnalyzerVersion(stdout: string): RustAnalyzerVersion | null {
  const match = BANNER.exec(stdout.trim());
  if (!match) return null;
  const [, version, commit, date] = match;
  return { version, commit, date };
}

/** First usable rust-analyzer in the mandated tier order, or null. */
export function discoverRustAnalyzer(deps: RustAnalyzerDiscoveryDeps): RustAnalyzerExecutable | null {
  const channel = pinnedToolchainChannel(deps);
  const tiers: [RustAnalyzerDiscoveryTier, () => Iterable<string>][] = [
    ["env", () => envCandidates(deps)],
    ["path", () => pathCandidates(deps)],
    ["rustup", () => rustupCandidates(deps, channel)],
    ["homebrew", () => HOMEBREW_DIRS.map((dir) => join(dir, BINARY))],
    ["asdf", () => asdfCandidates(deps)],
  ];
  for (const [tier, candidates] of tiers) {
    for (const candidate of candidates()) {
      const version = probeVersion(deps, candidate);
      if (!version) continue;
      return { path: candidate, tier, ...version, ...(tier === "rustup" && channel ? { toolchain: channel } : {}) };
    }
  }
  return null;
}

function probeVersion(deps: RustAnalyzerDiscoveryDeps, candidate: string): RustAnalyzerVersion | null {
  const outcome = deps.run(candidate, ["--version"], RUST_ANALYZER_VERSION_TIMEOUT_MS);
  return outcome.kind === "ok" ? parseRustAnalyzerVersion(outcome.stdout) : null;
}

function envCandidates(deps: RustAnalyzerDiscoveryDeps): string[] {
  const explicit = deps.env[RUST_ANALYZER_PATH_ENV];
  return explicit ? [explicit] : [];
}

function* pathCandidates(deps: RustAnalyzerDiscoveryDeps): Iterable<string> {
  for (const dir of (deps.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, BINARY);
    if (!deps.fs.exists(candidate)) continue;
    if (!isRustupProxy(deps, candidate)) {
      yield candidate;
      continue;
    }
    // The proxy answers only when the active toolchain carries the component;
    // `rustup which` names the real binary, or fails and rejects the stub.
    const real = rustupWhich(deps);
    if (real) yield real;
  }
}

function isRustupProxy(deps: RustAnalyzerDiscoveryDeps, candidate: string): boolean {
  const linkTarget = basename(deps.fs.realPath(candidate));
  if (linkTarget === "rustup" || linkTarget === "rustup-init") return true;
  const cargoHome = deps.env.CARGO_HOME ?? join(deps.homeDir, ".cargo");
  return dirname(candidate) === join(cargoHome, "bin");
}

function* rustupCandidates(deps: RustAnalyzerDiscoveryDeps, channel: string | undefined): Iterable<string> {
  if (channel) {
    const pinned = rustupWhich(deps, channel);
    if (pinned) yield pinned;
  }
  const toolchainsDir = join(deps.env.RUSTUP_HOME ?? join(deps.homeDir, ".rustup"), "toolchains");
  const toolchains = [...deps.fs.listDir(toolchainsDir)];
  // Project-pinned channel first; the rest keep the directory order.
  const ranked = channel
    ? [...toolchains.filter((t) => isChannelDir(t, channel)), ...toolchains.filter((t) => !isChannelDir(t, channel))]
    : toolchains;
  for (const toolchain of ranked) yield join(toolchainsDir, toolchain, "bin", BINARY);
}

function isChannelDir(toolchainDir: string, channel: string): boolean {
  return toolchainDir === channel || toolchainDir.startsWith(`${channel}-`);
}

function rustupWhich(deps: RustAnalyzerDiscoveryDeps, toolchain?: string): string | undefined {
  const args = ["which", BINARY, ...(toolchain ? ["--toolchain", toolchain] : [])];
  const outcome = deps.run("rustup", args, RUST_ANALYZER_VERSION_TIMEOUT_MS);
  if (outcome.kind !== "ok") return undefined;
  const path = outcome.stdout.trim();
  return path.length > 0 ? path : undefined;
}

function* asdfCandidates(deps: RustAnalyzerDiscoveryDeps): Iterable<string> {
  const dataDir = deps.env.ASDF_DATA_DIR ?? join(deps.homeDir, ".asdf");
  yield join(dataDir, "shims", BINARY);
  const installs = join(dataDir, "installs", "rust");
  for (const version of deps.fs.listDir(installs)) yield join(installs, version, "bin", BINARY);
}

/** The channel `rust-toolchain.toml` (or the legacy `rust-toolchain`) pins, if any. */
function pinnedToolchainChannel(deps: RustAnalyzerDiscoveryDeps): string | undefined {
  if (!deps.projectRoot) return undefined;
  for (const name of ["rust-toolchain.toml", "rust-toolchain"]) {
    const text = deps.fs.readFile(join(deps.projectRoot, name));
    if (text === undefined) continue;
    const toml = /^\s*channel\s*=\s*["']([^"']+)["']/m.exec(text);
    if (toml) return toml[1];
    const legacy = text.trim().split(/\r?\n/)[0]?.trim();
    if (legacy && !legacy.startsWith("[")) return legacy;
  }
  return undefined;
}

/** Discovery bound to the real host. */
export function defaultRustAnalyzerDiscoveryDeps(
  projectRoot: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RustAnalyzerDiscoveryDeps {
  return {
    env,
    homeDir: homedir(),
    projectRoot,
    run: runHostCommand,
    fs: {
      exists: (path) => existsSync(path),
      readFile: (path) => {
        try {
          return readFileSync(path, "utf8");
        } catch {
          return undefined;
        }
      },
      listDir: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return [];
        }
      },
      realPath: (path) => {
        try {
          return realpathSync(path);
        } catch {
          return path;
        }
      },
    },
  };
}

function runHostCommand(command: string, args: readonly string[], timeoutMs: number): RustAnalyzerCommandOutcome {
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

/** Builds a resolver that discovers once per project root and memoizes the answer. */
export function createRustAnalyzerResolver(
  discover: (projectRoot: string | undefined) => RustAnalyzerExecutable | null,
): (projectRoot?: string) => RustAnalyzerExecutable | null {
  const resolved = new Map<string, RustAnalyzerExecutable | null>();
  return (projectRoot) => {
    const key = projectRoot ?? "";
    if (!resolved.has(key)) resolved.set(key, discover(projectRoot));
    return resolved.get(key) ?? null;
  };
}
