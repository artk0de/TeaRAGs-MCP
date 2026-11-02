/**
 * Detached `tea-rags update --background` spawn (bd tea-rags-mcp-c2dr6) — the
 * same shape as the per-project auto-update spawner: own process group,
 * unref'd, stdout/stderr on the client-update log fd, failures swallowed.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { clientUpdateLogPath } from "./state-store.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface SpawnDetachedClientUpdateOptions {
  dataDir: string;
  spawnImpl?: typeof nodeSpawn;
  /** Test override; default resolves cli/index.js of this install. */
  cliEntryPath?: string;
}

/** `{src|build}/cli/client-update/spawner.{ts|js}` → `../index.js`: the SAME install that spawned it. */
function resolveOwnCliEntry(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

export function spawnDetachedClientUpdate(opts: SpawnDetachedClientUpdateOptions): void {
  let fd: number | undefined;
  try {
    const path = clientUpdateLogPath(opts.dataDir);
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(path, logOpenFlags(path));
    const child = (opts.spawnImpl ?? nodeSpawn)(
      process.execPath,
      [opts.cliEntryPath ?? resolveOwnCliEntry(), "update", "--background"],
      { detached: true, stdio: ["ignore", fd, fd] },
    );
    child.unref();
  } catch {
    // Fire-and-forget: prime must never fail on a spawn. The next prime retries.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Truncate (not rotate) past 5 MB — the log is a diagnostic tail. */
function logOpenFlags(path: string): "a" | "w" {
  try {
    return statSync(path).size > MAX_LOG_BYTES ? "w" : "a";
  } catch {
    return "a";
  }
}
