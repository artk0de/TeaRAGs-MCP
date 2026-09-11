import { execFileSync } from "node:child_process";

/** Where a failure is reported. Injectable so tests read the diagnostic instead of the terminal. */
export type CheckoutCommitWarn = (message: string) => void;

const warnToStderr: CheckoutCommitWarn = (message) => process.stderr.write(`${message}\n`);

/** Trimmed stdout of a git command in `root`, or null after saying why on `warn`. */
function git(root: string, args: readonly string[], warn: CheckoutCommitWarn): string | null {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error: unknown) {
    warn(`checkout-commit: \`git ${args.join(" ")}\` failed in ${root}: ${failureDetail(error)}`);
    return null;
  }
}

/** git's own first line of complaint, which is what makes a mistyped path diagnosable. */
function failureDetail(error: unknown): string {
  const captured = (error as { stderr?: Buffer | string } | null)?.stderr;
  const stderr = (typeof captured === "string" ? captured : (captured?.toString() ?? "")).trim();
  const text = stderr.length > 0 ? stderr : error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}

/**
 * The HEAD commit of another checkout, for spikes that compare this tree
 * against one.
 *
 * A cross-checkout run's verdict only means something next to the revision the
 * BEFORE side was sitting at — `--before-root /some/path` in a summary says
 * nothing once that checkout has moved on. Answering is best-effort by design:
 * the spikes run without a before-root at all (identity mode), and a path that
 * is not a checkout is a user mistake that must not take the run down, so both
 * come back as null for the caller to render as "unknown" — but never silently,
 * git's own complaint goes to `warn` so a mistyped path is diagnosable.
 *
 * The spikes import the BEFORE side from that checkout's WORKING TREE, not from
 * its commit, so a dirty tree is not the commit it names: the sha then carries a
 * `-dirty` suffix (`git status --porcelain`, untracked files included) and the
 * summary records a revision nobody can reconstruct rather than one that lies.
 *
 * Deliberately not the git adapter's `getHead(repoRoot)`
 * (`src/core/adapters/vcs/git/git-cli/client.ts`): that one is async, throws on
 * failure and returns `rev-parse`'s output unvalidated, where a spike wants a
 * synchronous, null-on-failure, 40-hex-checked answer — and pulling an adapter
 * in would drag core's import graph into a standalone script.
 */
export function resolveCheckoutCommit(
  root: string | undefined,
  warn: CheckoutCommitWarn = warnToStderr,
): string | null {
  if (root === undefined) return null;

  const head = git(root, ["rev-parse", "HEAD"], warn);
  if (head === null) return null;
  if (!/^[0-9a-f]{40}$/.test(head)) {
    warn(`checkout-commit: ${root} answered a HEAD that is not a full sha: ${head}`);
    return null;
  }

  const status = git(root, ["status", "--porcelain"], warn);
  return status === null || status === "" ? head : `${head}-dirty`;
}
