/**
 * Signal-0 liveness probe shared by every pid-file daemon (Qdrant, codegraph,
 * ONNX) and pid-stamped artifact (spill files, locks).
 *
 * `kill(pid, 0)` delivers nothing: ESRCH means no such process, EPERM means the
 * process EXISTS but this caller may not signal it — another user's process, or
 * any process outside a sandbox (Codex's macOS seatbelt denies signals to the
 * machine daemons). Reading EPERM as "dead" is what made a sandboxed client wipe
 * a live daemon's pid/port files and cold-spawn a second Qdrant over the same
 * storage (bd tea-rags-mcp-hdl65).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isSignalDenied(error);
  }
}

/** True for the EPERM a `process.kill` raises when the target exists but may not be signalled. */
export function isSignalDenied(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
}
