/**
 * Streaming spawn with an output-INACTIVITY watchdog.
 *
 * The CLI git timeouts exist to reap HUNG spawns, but `execFile`'s `timeout`
 * caps TOTAL duration — a full-history `git log HEAD --numstat` on a large
 * monolith (taxdome: 104MB over 122.9s) got SIGTERM'd at the 60s budget and
 * failed the whole git enrichment (tea-rags-mcp-w2dlu). This guard resets on
 * every stdout chunk: long-but-alive output completes regardless of total
 * duration; silence beyond the window kills the child and rejects.
 */

import { spawn } from "node:child_process";

export interface StallGuardOptions {
  cwd: string;
  /** Kill the child after this long with NO stdout activity (ms). */
  stallTimeoutMs: number;
}

export async function execWithStallGuard(command: string, args: string[], options: StallGuardOptions): Promise<string> {
  const { cwd, stallTimeoutMs } = options;
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stalled = false;

    let stallTimer: ReturnType<typeof setTimeout>;
    const resetStallTimer = (): void => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        child.kill("SIGKILL");
      }, stallTimeoutMs);
    };
    resetStallTimer();

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      resetStallTimer();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(stallTimer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(stallTimer);
      if (stalled) {
        reject(
          new Error(
            `Command stalled (no output for ${String(stallTimeoutMs)}ms): ${command} ${args.slice(0, 4).join(" ")}…`,
          ),
        );
        return;
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new Error(
            `Command failed (exit ${String(code)}): ${command} ${args.slice(0, 4).join(" ")}…${stderr ? `\n${stderr.slice(0, 500)}` : ""}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf8"));
    });
  });
}
