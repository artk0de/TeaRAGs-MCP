/**
 * Preconditions the background client update checks before touching the
 * global install (bd tea-rags-mcp-c2dr6).
 */

import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { IndexWorkerRecord } from "../index-progress/worker-registry.js";

const PACKAGE_NAME = "tea-rags";

/**
 * A dev install: the global `tea-rags` package dir is a symlink (`npm link`
 * into a checkout). Updating it would replace the developer's link. An
 * unknown global root or a missing package dir is not a dev install.
 */
export async function isLinkedGlobalInstall(globalRoot: () => Promise<string | null>): Promise<boolean> {
  const root = await globalRoot();
  if (root === null) return false;
  try {
    return (await lstat(join(root, PACKAGE_NAME))).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `npm root -g`, or null when npm cannot answer. */
export async function npmGlobalRoot(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("npm", ["root", "-g"], { timeout: 15_000 }, (error, stdout) => {
      const root = stdout.trim();
      resolve(error || root.length === 0 ? null : root);
    });
  });
}

/** Registered index workers whose process is still alive — a record left by a dead pid is not live work. */
export function liveIndexWorkers(
  registry: { list: () => IndexWorkerRecord[] },
  isAlive: (pid: number) => boolean,
): IndexWorkerRecord[] {
  return registry.list().filter((record) => isAlive(record.pid));
}

/** Signal-0 probe: EPERM still means the pid exists. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
