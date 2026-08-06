/**
 * Auto-update log sink — one append-only file per project under
 * `<dataDir>/logs/auto-update-<label>.log`. The detached updater's
 * stdout/stderr both point at this fd, so a failed run leaves a full trace
 * without any live parent process. Truncated (not rotated) past 5 MB —
 * the log is a diagnostic tail, not an archive.
 */

import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface AutoUpdateLogHandle {
  fd: number;
  path: string;
}

export function openAutoUpdateLog(dataDir: string, projectLabel: string): AutoUpdateLogHandle {
  const dir = join(dataDir, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `auto-update-${projectLabel}.log`);
  let flags = "a";
  try {
    if (statSync(path).size > MAX_LOG_BYTES) flags = "w";
  } catch {
    // Missing file — the append open creates it.
  }
  const fd = openSync(path, flags);
  return { fd, path };
}

export function closeAutoUpdateLog(handle: AutoUpdateLogHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // Already closed / invalid — nothing to release.
  }
}

/** Path-only variant for status rendering (no fd opened). */
export function autoUpdateLogPath(dataDir: string, projectLabel: string): string {
  return join(dataDir, "logs", `auto-update-${projectLabel}.log`);
}
