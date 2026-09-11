import { execFileSync } from "node:child_process";

/**
 * The HEAD commit of another checkout, for spikes that compare this tree
 * against one.
 *
 * A cross-checkout run's verdict only means something next to the revision the
 * BEFORE side was sitting at — `--before-root /some/path` in a summary says
 * nothing once that checkout has moved on. Answering is best-effort by design:
 * the spikes run without a before-root at all (identity mode), and a path that
 * is not a checkout is a user mistake that must not take the run down, so both
 * come back as null for the caller to render as "unknown".
 */
export function resolveCheckoutCommit(root: string | undefined): string | null {
  if (root === undefined) return null;
  try {
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}
