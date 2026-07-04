/**
 * Build fingerprint — stable identifier of the RUNNING build, shared by the
 * codegraph daemon and its clients (bd tea-rags-mcp-ji56r).
 *
 * After `npm run build && npm link` a long-lived daemon keeps executing OLD
 * code: protocol ops / schema migrations present in the client's build can be
 * missing daemon-side. Both peers exchange this fingerprint in the `handshake`
 * op; a mismatch tells the client to drain-restart the daemon from ITS build.
 *
 * Composition: `<realpath of this module's directory>|<package version>|<mtime
 * of this module file>`. Both peers load the same physical module file when
 * they run the same build, so:
 * - `npm link` re-pointed at another worktree → realpath differs → mismatch;
 * - in-place rebuild (`tsc` rewrites every output) → mtime differs → mismatch;
 * - published version bump → version differs → mismatch.
 *
 * `TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT` overrides the computed value — the
 * integration-test hook to force a spawned daemon onto a different identity.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Compute the fingerprint for `moduleFilePath` (defaults to THIS module — the
 * one artifact both the daemon and the client load from the same build tree).
 */
export function computeBuildFingerprint(moduleFilePath: string = fileURLToPath(import.meta.url)): string {
  const realFile = realpathSync(moduleFilePath);
  const dir = dirname(realFile);
  return `${dir}|${findPackageVersion(dir)}|${statSync(realFile).mtimeMs}`;
}

/** Walk up from `fromDir` to the nearest package.json with a version field. */
function findPackageVersion(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    } catch {
      // No package.json at this level (or unparseable) — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return "unknown";
    dir = parent;
  }
}

let cached: string | undefined;

/**
 * The process-wide fingerprint used in the daemon handshake. Computed once at
 * first use (the build tree cannot change under a running process without a
 * restart being the correct outcome anyway). The env override is re-read on
 * every call so tests can toggle it without module-cache gymnastics.
 */
export function getBuildFingerprint(): string {
  const override = process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT;
  if (override) return override;
  cached ??= computeBuildFingerprint();
  return cached;
}
