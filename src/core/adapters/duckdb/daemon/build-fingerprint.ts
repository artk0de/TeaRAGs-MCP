/**
 * Build fingerprint — stable identifier of the RUNNING build, shared by the
 * codegraph daemon and its clients (bd tea-rags-mcp-ji56r).
 *
 * After `npm run build && npm link` a long-lived daemon keeps executing OLD
 * code: protocol ops / schema migrations present in the client's build can be
 * missing daemon-side. Both peers exchange this fingerprint in the `handshake`
 * op. A mismatch alone does not say WHICH peer is stale — a long-lived client
 * ages the same way — so the client also reads the build on disk NOW
 * (`readOnDiskBuildFingerprint`, bd tea-rags-mcp-1wr7p) before deciding
 * whether to drain-restart the daemon.
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

/**
 * A build fingerprint as LOADED, next to a reader for the build on disk NOW
 * (bd tea-rags-mcp-1wr7p). A long-lived process keeps executing the code it
 * loaded while a rebuild, `npm link` or `npm i -g` upgrade rewrites the tree
 * under it; the two views disagreeing is how the handshake tells "this process
 * is stale" from "the daemon is stale".
 */
export interface BuildFingerprintCapture {
  /** Fingerprint of the build as loaded — fixed at capture time. */
  readonly loaded: string;
  /**
   * Fingerprint of the build on disk right now, recomputed on every call.
   * Undefined when the module file cannot be read (the tree is gone): there is
   * then nothing to compare against.
   */
  readonly readOnDisk: () => string | undefined;
}

/** Capture `moduleFilePath`'s fingerprint now, keeping a reader for later rewrites. */
export function captureBuildFingerprint(
  moduleFilePath: string = fileURLToPath(import.meta.url),
): BuildFingerprintCapture {
  return {
    loaded: computeBuildFingerprint(moduleFilePath),
    readOnDisk: () => {
      try {
        return computeBuildFingerprint(moduleFilePath);
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * THIS process's build, captured at module load — not at first use. A process
 * that made no graph call before a rebuild would otherwise fingerprint the NEW
 * build on its first handshake while still running the OLD code, and the skew
 * would pass unseen. The module sits in the static import graph of both the
 * daemon and the MCP server, so load time is process start.
 */
const processBuild = captureBuildFingerprint();

/**
 * The process-wide fingerprint used in the daemon handshake: the build this
 * process LOADED. The env override is re-read on every call so tests can toggle
 * it without module-cache gymnastics.
 */
export function getBuildFingerprint(): string {
  const override = process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT;
  if (override) return override;
  return processBuild.loaded;
}

/**
 * The fingerprint of this process's build tree as it is on disk NOW — what a
 * daemon spawned from this tree would report (bd tea-rags-mcp-1wr7p). Honours
 * the env override like `getBuildFingerprint`: a forced identity has no stale
 * side.
 */
export function readOnDiskBuildFingerprint(): string | undefined {
  const override = process.env.TEA_RAGS_CODEGRAPH_BUILD_FINGERPRINT;
  if (override) return override;
  return processBuild.readOnDisk();
}
