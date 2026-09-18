/**
 * Parent-death guard for the detached `index-codebase` worker.
 *
 * The worker is forked into its OWN process group so it can outlive the
 * foreground in default mode — which also means killing the foreground (CLI or
 * MCP host) never reaches the worker or the git / chunker children it started.
 * On a CLEAN background hand-off the supervisor sends `{type:"outlive"}` and
 * then disconnects; a disconnect WITHOUT that grant means the supervisor died,
 * and the worker is an orphan that would otherwise keep indexing — and keep its
 * collection's indexing lock heartbeating — for nobody.
 *
 * Dependency-free on purpose: it is installed before the worker loads anything
 * heavy, so the window in which a dying supervisor goes unnoticed stays small.
 */

/** The worker's IPC end (`process`) — test-fakeable. */
export interface ParentDeathGuardChannel {
  /** `undefined` for a process started without an IPC channel. */
  readonly connected?: boolean;
  on: ((event: "message", listener: (message: unknown) => void) => unknown) &
    ((event: "disconnect", listener: () => void) => unknown);
}

export interface ParentDeathGuardHooks {
  /** The supervisor is gone and never handed the worker off — tear the worker down. */
  onOrphaned: () => void;
  /** The supervisor granted "outlive": the worker now runs without a parent by design. */
  onOutlive?: () => void;
}

function isOutliveGrant(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "outlive";
}

/**
 * Arm the guard. A channel that is ALREADY disconnected at install time is an
 * orphan too (bd tea-rags-mcp-f924y): Node emits `disconnect` once, to whoever
 * listens at that moment, so a supervisor that died while the worker was still
 * loading its modules left a worker that no later listener would ever hear
 * about. An outlive grant cannot precede this point — the supervisor sends it
 * only after the worker reports the index searchable.
 */
export function installParentDeathGuard(channel: ParentDeathGuardChannel, hooks: ParentDeathGuardHooks): void {
  let outliveParent = false;
  channel.on("message", (message) => {
    if (!isOutliveGrant(message)) return;
    outliveParent = true;
    hooks.onOutlive?.();
  });
  channel.on("disconnect", () => {
    if (outliveParent) return;
    hooks.onOrphaned();
  });
  if (channel.connected === false) hooks.onOrphaned();
}
