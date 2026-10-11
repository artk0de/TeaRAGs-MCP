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
 * there is one code path and no platform branch. Only an explicit failure of
 * that run rejects the candidate; a timeout is retried, never a verdict (see
 * `probeGitExecutable`).
 *
 * The decision is memoized per module instance: once per process, and once per
 * worker thread (each thread loads its own copy of this module).
 *
 * Lives beside the git-cli adapter rather than inside it because
 * `adapters/vcs/git/repo-git-state.ts` and `adapters/filesystem/dependency-manifests.ts`
 * spawn git too; every spawning site reaches it from `adapters/vcs/git/`.
 */

import { spawnSync } from "node:child_process";

/** Apple's platform-signed git on macOS; the distro git on most Linux systems. */
export const PLATFORM_GIT_EXECUTABLE = "/usr/bin/git";

/** Fallback: whatever `git` the PATH resolves to (Homebrew on macOS). */
export const PATH_GIT_EXECUTABLE = "git";

/**
 * Per-attempt windows for the `--version` probe (bd tea-rags-mcp-0qaht.67).
 * Under induced load the probe of `/usr/bin/git` measured p50 0.9–1.8s with a
 * max of ~3.3s, so the first window sits above the observed max with margin;
 * the second is a hang-only bound — it exists to stop a wedged child, not to
 * judge a slow one.
 */
const GIT_PROBE_ATTEMPT_TIMEOUTS_MS = [5000, 30_000] as const;

/** Decides whether a git candidate can actually run. */
export type GitExecutableProbe = (candidate: string) => boolean;

type GitProbeAttemptVerdict = "usable" | "unusable" | "timed-out";

function probeGitExecutableOnce(
  candidate: string,
  timeoutMs: number,
  spawnSyncImpl: typeof spawnSync | undefined,
): GitProbeAttemptVerdict {
  try {
    // Resolved inside the try: even reaching `spawnSync` can throw (a module
    // mock without that export), and the probe must still answer "unusable".
    const result = (spawnSyncImpl ?? spawnSync)(candidate, ["--version"], {
      timeout: timeoutMs,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }) as ReturnType<typeof spawnSync> | undefined;
    if (!result) return "unusable";
    const spawnError: NodeJS.ErrnoException | undefined = result.error;
    if (spawnError?.code === "ETIMEDOUT") return "timed-out";
    if (spawnError || result.status !== 0) return "unusable";
    return String(result.stdout).startsWith("git version") ? "usable" : "unusable";
  } catch {
    return "unusable";
  }
}

/**
 * False iff `<candidate> --version` FAILS EXPLICITLY: ENOENT/EACCES, the xcrun
 * shim's non-zero exit, output that is not a `git version` banner, a throwing
 * spawn. A timeout is NO verdict (bd tea-rags-mcp-0qaht.67): a loaded machine
 * makes the probe slow, and treating slow as broken permanently moved the
 * process — and every worker adopting its choice — onto the EDR-throttled PATH
 * git. A timed-out attempt is retried with the next, longer window. If every
 * window times out the candidate is KEPT: ~35s without an answer means the
 * machine is starved, and PATH git would be no faster there; falling back would
 * trade a probe we could not read for a known ~3x throughput loss for the rest
 * of the process. No caller relies on the probe having proven responsiveness —
 * the hot blame/log spawns run under `execWithStallGuard`, so a git that truly
 * hangs fails loudly there instead of degrading silently here.
 */
export function probeGitExecutable(candidate: string, spawnSyncImpl?: typeof spawnSync): boolean {
  for (const timeoutMs of GIT_PROBE_ATTEMPT_TIMEOUTS_MS) {
    const verdict = probeGitExecutableOnce(candidate, timeoutMs, spawnSyncImpl);
    if (verdict !== "timed-out") return verdict === "usable";
  }
  return true;
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
