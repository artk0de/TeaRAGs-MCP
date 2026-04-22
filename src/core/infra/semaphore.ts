/**
 * Async semaphore for bounding concurrent async operations.
 * acquire() returns a release function. If at capacity, acquire() blocks
 * until a slot opens.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  /** Number of waiters currently blocked. */
  get pending(): number {
    return this.queue.length;
  }

  async acquire(): Promise<() => void> {
    if (this.max <= 0) return () => {};

    if (this.active < this.max) {
      this.active++;
      return () => {
        this.release();
      };
    }

    return new Promise<() => void>((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => {
          this.release();
        });
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
