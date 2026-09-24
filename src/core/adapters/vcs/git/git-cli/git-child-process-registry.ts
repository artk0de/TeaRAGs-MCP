/**
 * Process-wide registry of the git children this process spawned
 * (bd tea-rags-mcp-w26dc).
 *
 * The forked CLI worker reaps its git children by group-killing itself on
 * parent death (`src/cli/index-progress/parent-death-guard.ts`). The MCP server
 * has no such worker: `index_codebase` runs `App#indexCodebase` in the server
 * process and the git trajectory is dispatched inline, so every git spawn is a
 * direct child of the server — in the server's (host-owned) process group,
 * which the server must not group-kill. Its shutdown path (`ctx.cleanup`) reaps
 * them through this registry instead.
 *
 * Scope: the async git-cli spawns only. `execFileSync` calls block the event
 * loop, so a signal handler can never run while one is in flight.
 * An abrupt SIGKILL of the server cannot be handled in-process; there the
 * orphans are bounded by the pipes — a streaming git dies of SIGPIPE on its next
 * write, a `cat-file --batch` reader exits on stdin EOF.
 */

import type { ChildProcess } from "node:child_process";

const liveGitChildren = new Set<ChildProcess>();

/** Register a git child; it is forgotten on its own once it exits. */
export function trackGitChildProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  liveGitChildren.add(child);
  const forget = (): void => {
    liveGitChildren.delete(child);
  };
  child.once("exit", forget);
  child.once("error", forget);
}

/**
 * SIGKILL every tracked git child still running. Returns how many were
 * signalled. The pending calls that own them reject through their normal
 * close/exit handling.
 */
export function reapGitChildProcesses(): number {
  let reaped = 0;
  for (const child of liveGitChildren) {
    liveGitChildren.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) continue;
    if (child.kill("SIGKILL")) reaped++;
  }
  return reaped;
}
