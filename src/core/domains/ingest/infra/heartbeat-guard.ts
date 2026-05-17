/**
 * HeartbeatGuard — starts a heartbeat for the duration of a function, then
 * stops it in a `finally` block.
 *
 * Stop always runs, even when the wrapped function throws — no zombie timers
 * after a failed ingest run.
 */

export interface HeartbeatOptions {
  /** Called on entry. Returns a stop function invoked in `finally`. */
  start: () => () => void;
  /** Documentation-only — interval is owned by the start callback. */
  intervalMs?: number;
}

export class HeartbeatGuard {
  constructor(private readonly opts: HeartbeatOptions) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const stop = this.opts.start();
    try {
      return await fn();
    } finally {
      stop();
    }
  }
}
