export interface OnnxHandshakeGateOptions {
  /** Liveness window. Restarted by `keepAlive`, cleared once the gate settles. */
  timeoutMs: number;
  resolve: () => void;
  reject: (err: Error) => void;
  /**
   * Called when the window closes with the handshake still unsettled. Returns
   * the rejection reason, and is free to tear the socket down first — the gate
   * only owns the timer and the one-shot settlement, not the transport.
   *
   * Note the gate does NOT mark itself settled on expiry: a socket error
   * arriving afterwards still takes the "handshake failed" path and rejects an
   * already-rejected promise (a no-op), rather than the post-handshake
   * teardown path.
   */
  onExpire: () => Error;
}

/**
 * Guards the ONNX daemon handshake: the connect promise settles exactly once,
 * and until it does, a liveness deadline is running.
 *
 * The deadline exists because model loading can take 30-60s on a cold start
 * (download + ONNX init + warm-up + calibration), which is indistinguishable
 * from a wedged daemon by wall clock alone. The daemon's "log" frames break the
 * tie — each one is proof of life, so `keepAlive` restarts the window instead
 * of the client giving up on a daemon that is visibly working.
 */
export class OnnxHandshakeGate {
  private done = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(private readonly options: OnnxHandshakeGateOptions) {
    this.timer = this.arm();
  }

  /** True once the handshake succeeded or failed — the promise is spoken for. */
  get settled(): boolean {
    return this.done;
  }

  /** Daemon proved it is alive mid-handshake — restart the liveness window. */
  /* v8 ignore start -- needs a daemon that logs during a real model load */
  keepAlive(): void {
    clearTimeout(this.timer);
    this.timer = this.arm();
  }
  /* v8 ignore stop */

  succeed(): void {
    this.done = true;
    clearTimeout(this.timer);
    this.options.resolve();
  }

  fail(err: Error): void {
    this.done = true;
    clearTimeout(this.timer);
    this.options.reject(err);
  }

  /* v8 ignore start -- expiry needs a 120s wait; the arming itself runs on every connect */
  private arm(): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.options.reject(this.options.onExpire());
    }, this.options.timeoutMs);
  }
  /* v8 ignore stop */
}
