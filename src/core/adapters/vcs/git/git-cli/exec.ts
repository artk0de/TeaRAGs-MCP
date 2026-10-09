/**
 * Git CLI exec primitives shared by the git-cli modules: `execFile` as a
 * promise under the git child env contract, and the bulk-log stall floor.
 */

import { execFile, type ExecFileOptions } from "node:child_process";

import { buildGitChildProcessEnv } from "../../../../infra/git-executable.js";
import { trackGitChildProcess } from "./git-child-process-registry.js";

/**
 * `execFile` as a promise, with the child registered for shutdown reaping (bd
 * tea-rags-mcp-w26dc) and run under the git child env contract — optional locks
 * off (bd tea-rags-mcp-s5kpv). Git-only, like `execWithStallGuard`.
 */
export async function execFileAsync(
  file: string,
  args: string[],
  options: ExecFileOptions & { encoding?: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { ...options, encoding: options.encoding ?? "utf8", env: buildGitChildProcessEnv(options.env) },
      (err: Error | null, stdout: string, stderr: string) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    trackGitChildProcess(child);
  });
}

// ── Generic utility ──────────────────────────────────────────────

/**
 * A bulk `git log` can be legitimately SILENT for minutes while staying
 * alive: computing --numstat for one giant commit (vendored tree import,
 * repo-wide migration) emits nothing until that diff finishes — taxdome got
 * a real 60s+ gap mid-stream. The stall window exists to reap HUNGS, so it
 * is floored well above any legitimate thinking pause; caller-provided
 * windows can only RAISE it.
 */
export const BULK_LOG_STALL_FLOOR_MS = 600_000;
