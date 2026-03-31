/**
 * OperationLock — prevents mid-operation URL switching in OllamaEmbeddings.
 *
 * Pure data structure with refcounting and mutex. Created only when
 * fallbackBaseUrl is configured — no lock, no overhead otherwise.
 *
 * First acquire() triggers async URL resolution (health check).
 * Concurrent callers wait on the same Promise and get the same URL.
 * While any embed is in flight, the URL stays locked.
 */
export class OperationLock {
  private count = 0;
  private lockedUrl: string | null = null;
  private _pendingRecovery = false;
  private resolving: Promise<string> | null = null;
  private staleTimer?: ReturnType<typeof setTimeout>;

  /**
   * Acquire the lock. First caller triggers async URL resolution (health
   * check). Concurrent callers wait on the mutex and get the same URL.
   * Rolls back count on resolution failure — error propagates to caller.
   */
  async acquire(resolveUrl: () => Promise<string>, staleTimeoutMs?: number): Promise<string> {
    this.count++;
    if (this.count === 1) {
      this.resolving = resolveUrl();
      try {
        this.lockedUrl = await this.resolving;
      } catch (error) {
        this.count--;
        this.resolving = null;
        throw error;
      }
      this.resolving = null;
      if (staleTimeoutMs) {
        this.staleTimer = setTimeout(() => {
          this.forceRelease();
        }, staleTimeoutMs);
        this.staleTimer.unref();
      }
    } else if (this.resolving) {
      try {
        await this.resolving;
      } catch (error) {
        this.count--;
        throw error;
      }
    }
    return this.lockedUrl as string;
  }

  /**
   * Release the lock. When count reaches 0, returns whether a deferred
   * recovery is pending. Caller is responsible for acting on it.
   */
  release(): { recovered: boolean } {
    if (this.count <= 0) return { recovered: false };
    this.count--;
    if (this.count === 0) {
      this.lockedUrl = null;
      this.clearStaleTimer();
      if (this._pendingRecovery) {
        this._pendingRecovery = false;
        return { recovered: true };
      }
    }
    return { recovered: false };
  }

  get isActive(): boolean {
    return this.count > 0;
  }

  get url(): string | null {
    return this.lockedUrl;
  }

  /** Mark that probe detected primary recovery, to be applied on release. */
  deferRecovery(): void {
    this._pendingRecovery = true;
  }

  /** Force-release all acquisitions (stale timeout safety net). */
  private forceRelease(): void {
    this.count = 0;
    this.lockedUrl = null;
    this._pendingRecovery = false;
    this.clearStaleTimer();
  }

  private clearStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = undefined;
    }
  }
}
