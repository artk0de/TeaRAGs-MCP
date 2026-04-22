import { describe, expect, it } from "vitest";

import { Semaphore } from "../../../src/core/infra/semaphore.js";

describe("Semaphore", () => {
  it("allows up to N concurrent acquisitions", async () => {
    const sem = new Semaphore(2);
    const order: string[] = [];

    const task = async (id: string, delayMs: number) => {
      const release = await sem.acquire();
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, delayMs));
      order.push(`end-${id}`);
      release();
    };

    await Promise.all([task("a", 50), task("b", 50), task("c", 10)]);

    expect(order.indexOf("start-a")).toBeLessThan(order.indexOf("start-c"));
    expect(order.indexOf("start-b")).toBeLessThan(order.indexOf("start-c"));
  });

  it("release unblocks waiting acquirers", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let acquired = false;
    const p = sem.acquire().then((r) => {
      acquired = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false);

    release1();
    const release2 = await p;
    expect(acquired).toBe(true);
    release2();
  });

  it("handles concurrency=0 by allowing unlimited", async () => {
    const sem = new Semaphore(0);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    r1();
    r2();
  });

  it("exposes pending count", async () => {
    const sem = new Semaphore(1);
    expect(sem.pending).toBe(0);

    const r1 = await sem.acquire();
    const p = sem.acquire();
    await new Promise((r) => setTimeout(r, 5));
    expect(sem.pending).toBe(1);

    r1();
    const r2 = await p;
    expect(sem.pending).toBe(0);
    r2();
  });
});
