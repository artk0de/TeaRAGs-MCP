/**
 * Which git binary every tea-rags git spawn runs.
 *
 * Prefers Apple's platform git (`/usr/bin/git`) and falls back to `git` from
 * PATH. Measured on macOS with an Endpoint Security agent (SentinelOne/Avira):
 * the agent evaluates every NEW command line of the ad-hoc-signed Homebrew git
 * (first on PATH) serially at ~16ms each, capping fresh-argv git spawns at
 * ~38/s machine-wide with zero parallel scaling. The platform-signed
 * `/usr/bin/git` is not throttled — real `git blame --porcelain HEAD` on a large
 * repo at 12-way parallelism ran 127/s through it versus 36.8/s through
 * Homebrew git. Git enrichment spawns one blame and one log per file, so the
 * binary choice alone decides its throughput.
 *
 * "Usable" is decided by RUNNING `/usr/bin/git --version`, never by
 * `existsSync`: on macOS without Command Line Tools `/usr/bin/git` is an xcrun
 * shim that requests an install and exits non-zero. On other platforms the
 * same probe holds (on Linux `/usr/bin/git` is normally the distro git), so
 * there is one code path and no platform branch.
 *
 * The decision is memoized per module instance: once per process, and once per
 * worker thread (each thread loads its own copy of this module).
 *
 * Lives in `infra` rather than the git-cli adapter because
 * `infra/repo-git-state.ts` spawns git too, and `infra` may not import
 * `adapters` — the foundation is the only layer every spawning site can reach.
 */

import { spawnSync } from "node:child_process";

/** Apple's platform-signed git on macOS; the distro git on most Linux systems. */
export const PLATFORM_GIT_EXECUTABLE = "/usr/bin/git";

/** Fallback: whatever `git` the PATH resolves to (Homebrew on macOS). */
export const PATH_GIT_EXECUTABLE = "git";

const GIT_PROBE_TIMEOUT_MS = 3000;

/** Decides whether a git candidate can actually run. */
export type GitExecutableProbe = (candidate: string) => boolean;

/**
 * True iff `<candidate> --version` exits 0 within the timeout and prints a
 * `git version` banner. Any failure — ENOENT, timeout, the xcrun shim's
 * non-zero exit, unexpected output, a throwing spawn — reads as unusable.
 */
export function probeGitExecutable(candidate: string, spawnSyncImpl?: typeof spawnSync): boolean {
  try {
    // Resolved inside the try: even reaching `spawnSync` can throw (a module
    // mock without that export), and the probe must still answer "unusable".
    const result = (spawnSyncImpl ?? spawnSync)(candidate, ["--version"], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }) as ReturnType<typeof spawnSync> | undefined;
    if (!result || result.error || result.status !== 0) return false;
    return String(result.stdout).startsWith("git version");
  } catch {
    return false;
  }
}

/** Builds a resolver that probes the platform git once and memoizes the answer. */
export function createGitExecutableResolver(probe: GitExecutableProbe = probeGitExecutable): () => string {
  let resolved: string | undefined;
  return () => {
    resolved ??= probe(PLATFORM_GIT_EXECUTABLE) ? PLATFORM_GIT_EXECUTABLE : PATH_GIT_EXECUTABLE;
    return resolved;
  };
}

const probedGitExecutable = createGitExecutableResolver();
let adoptedGitExecutable: string | undefined;

/** The git binary every tea-rags git spawn uses. Probes on first call, memoized after. */
export function resolveGitExecutable(): string {
  return adoptedGitExecutable ?? probedGitExecutable();
}

/**
 * The environment every tea-rags git child runs under: `base` (the parent's
 * environment by default) with git's OPTIONAL locks disabled (bd
 * tea-rags-mcp-s5kpv).
 *
 * `git status` (and other read commands) opportunistically take `index.lock`
 * in the user's tree to write refreshed stat info back. A child reaped mid-run
 * — stall-guard kill, CLI exit — leaves that lock behind and blocks the user's
 * next `git commit`; even a live one races it. `GIT_OPTIONAL_LOCKS=0` turns
 * only those optional locks off: locks a command genuinely needs (`git worktree
 * add`, `git add -N` into a scratch index) are still taken, so the contract
 * applies to every git child with no read/write split to maintain.
 *
 * Returns a fresh object; `process.env` is never mutated. Worker threads get
 * the same contract because their spawns go through the same call sites.
 */
export function buildGitChildProcessEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, GIT_OPTIONAL_LOCKS: "0" };
}

/**
 * Worker-thread entry: take the executable the spawning thread already
 * resolved (handed over via `workerData`) instead of probing again, so a
 * process decides once and every thread follows that decision.
 */
export function adoptGitExecutable(executable: string): void {
  adoptedGitExecutable = executable;
}
