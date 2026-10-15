/**
 * EmbeddingEndpointSlotLimiter — per-endpoint FIFO slot semaphore shared by
 * every concurrent embed call of ONE provider instance.
 *
 * An embedding server exposes a fixed number of slots (llama-server: `/props`
 * `total_slots`). Each embed call fans its batch out over those slots, and the
 * pipeline runs several calls at once; without a cap shared across calls the
 * requests pile up in the server's queue, where they count against their own
 * request timeout. A request holds a lease of its endpoint for as long as it is
 * on the wire, so at most `capacity` requests per endpoint are ever in flight.
 *
 * Capacity is per endpoint and taken from the latest `acquire`: a re-read
 * `/props` that reports another slot count applies at once — a raised capacity
 * wakes waiters, a lowered one stops granting until enough leases return.
 * Waiters are served first come, first served across all callers. Pure: no I/O,
 * no timers.
 */

/** Gives the lease back. Idempotent: a second call frees nothing. */
export type EmbeddingEndpointSlotRelease = () => void;

interface EndpointSlots {
  capacity: number;
  inFlight: number;
  waiters: (() => void)[];
}

export class EmbeddingEndpointSlotLimiter {
  private readonly endpoints = new Map<string, EndpointSlots>();

  /**
   * Wait for a free slot of `url`, `capacity` slots wide (below 1 counts as 1).
   * Resolves with the release, or with undefined when `signal` aborts first —
   * the waiter is then dropped from the queue and holds nothing.
   */
  async acquire(
    url: string,
    capacity: number,
    signal?: AbortSignal,
  ): Promise<EmbeddingEndpointSlotRelease | undefined> {
    if (signal?.aborted) return undefined;
    const slots = this.slotsOf(url);
    slots.capacity = Math.max(1, Math.floor(capacity));
    if (slots.waiters.length === 0 && slots.inFlight < slots.capacity) {
      slots.inFlight += 1;
      return this.leaseOf(url, slots);
    }
    const lease = new Promise<EmbeddingEndpointSlotRelease | undefined>((resolve) => {
      const grant = (): void => {
        signal?.removeEventListener("abort", cancel);
        resolve(this.leaseOf(url, slots));
      };
      const cancel = (): void => {
        const at = slots.waiters.indexOf(grant);
        if (at >= 0) slots.waiters.splice(at, 1);
        resolve(undefined);
      };
      slots.waiters.push(grant);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    this.grantWaiting(slots);
    return lease;
  }

  /** Leases of `url` held right now. */
  inFlight(url: string): number {
    return this.endpoints.get(url)?.inFlight ?? 0;
  }

  /** Acquirers of `url` still waiting for a slot. */
  waiting(url: string): number {
    return this.endpoints.get(url)?.waiters.length ?? 0;
  }

  private slotsOf(url: string): EndpointSlots {
    let slots = this.endpoints.get(url);
    if (!slots) {
      slots = { capacity: 1, inFlight: 0, waiters: [] };
      this.endpoints.set(url, slots);
    }
    return slots;
  }

  private leaseOf(url: string, slots: EndpointSlots): EmbeddingEndpointSlotRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slots.inFlight -= 1;
      this.grantWaiting(slots);
      if (slots.inFlight === 0 && slots.waiters.length === 0) this.endpoints.delete(url);
    };
  }

  private grantWaiting(slots: EndpointSlots): void {
    while (slots.inFlight < slots.capacity) {
      const grant = slots.waiters.shift();
      if (!grant) return;
      slots.inFlight += 1;
      grant();
    }
  }
}
