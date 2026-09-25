/**
 * BlameWorkerPool concurrency contract — mocks node:worker_threads with a fake
 * Worker so the test controls exactly when each blame job is answered and can
 * observe how many jobs a worker holds in flight.
 *
 * Regression for the process flood: with unbounded streaming batches every
 * blame() call posted a job to each worker immediately and the worker ran
 * them concurrently (1354 `git blame` children → spawn EAGAIN). The pool must
 * hold at most ONE in-flight blame job per worker.
 */

import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChurnWalkThreadRequest } from "../../../../../../../src/core/domains/trajectory/git/infra/churn-walk/protocol.js";

interface PostedBlame {
  worker: FakeWorker;
  id: number;
  files: string[];
}

class FakeWorker extends EventEmitter {
  inFlight = 0;
  maxInFlight = 0;

  postMessage(message: ChurnWalkThreadRequest): void {
    if (message.type === "close") {
      setImmediate(() => this.emit("exit", 0));
      return;
    }
    if (message.type !== "blame") return;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    state.posted.push({ worker: this, id: message.id, files: message.job.files.map((f) => f.relPath) });
  }

  async terminate(): Promise<number> {
    return 0;
  }
}

const state = vi.hoisted(() => ({
  workers: [] as unknown[],
  posted: [] as PostedBlame[],
}));

vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor() {
      const worker = new FakeWorker();
      state.workers.push(worker);
      return worker;
    }
  },
}));

const { BlameWorkerPool } =
  await import("../../../../../../../src/core/domains/trajectory/git/infra/churn-walk/blame-pool.js");

function answer(job: PostedBlame, outcome: "blamed" | "blame-failed"): void {
  job.worker.inFlight--;
  if (outcome === "blamed") {
    const blameByPath = new Map(job.files.map((relPath) => [relPath, []]));
    job.worker.emit("message", { type: "blamed", id: job.id, blameByPath });
  } else {
    job.worker.emit("message", { type: "blame-failed", id: job.id, error: "boom" });
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Answer whatever is posted but not yet answered, until nothing new arrives. */
async function drain(outcomeFor: (job: PostedBlame) => "blamed" | "blame-failed" = () => "blamed"): Promise<void> {
  let answered = 0;
  for (;;) {
    await flush();
    if (answered === state.posted.length) return;
    const batch = state.posted.slice(answered);
    answered = state.posted.length;
    for (const job of batch) answer(job, outcomeFor(job));
  }
}

const files = (prefix: string, n: number): { relPath: string; historyDepthHint: number }[] =>
  Array.from({ length: n }, (_, i) => ({ relPath: `${prefix}-${i}.ts`, historyDepthHint: 1 }));

describe("BlameWorkerPool concurrency bound", () => {
  beforeEach(() => {
    state.workers.length = 0;
    state.posted.length = 0;
  });

  it("never holds more than one in-flight blame job per worker across concurrent blame() calls", async () => {
    const size = 3;
    const calls = 12;
    const pool = new BlameWorkerPool(size);
    const results = Array.from({ length: calls }, async (_, k) => pool.blame("/repo", "git", files(`c${k}`, 6), 1000));

    await flush();
    // Only the first shard per worker is posted up-front.
    expect(state.posted.length).toBe(size);

    await drain();
    const maps = await Promise.all(results);
    maps.forEach((map, k) => {
      expect([...map.keys()].sort()).toEqual(
        files(`c${k}`, 6)
          .map((f) => f.relPath)
          .sort(),
      );
    });

    expect(state.workers.length).toBe(size);
    for (const worker of state.workers as FakeWorker[]) expect(worker.maxInFlight).toBe(1);
    expect(state.posted.length).toBe(size * calls);
    await pool.close();
  });

  it("a failed blame job does not stall the jobs queued behind it on the same worker", async () => {
    const pool = new BlameWorkerPool(1);
    const first = pool.blame("/repo", "git", files("first", 2), 1000);
    const second = pool.blame("/repo", "git", files("second", 2), 1000);
    const firstSettled = first.then(
      () => "resolved",
      () => "rejected",
    );

    await drain((job) => (job.files[0].startsWith("first") ? "blame-failed" : "blamed"));

    expect(await firstSettled).toBe("rejected");
    const secondMap = await second;
    expect([...secondMap.keys()].sort()).toEqual(["second-0.ts", "second-1.ts"]);
    await pool.close();
  });

  it("close() rejects both the in-flight and the queued blame jobs", async () => {
    const pool = new BlameWorkerPool(1);
    const inFlight = pool.blame("/repo", "git", files("a", 1), 1000);
    const queued = pool.blame("/repo", "git", files("b", 1), 1000);
    const inFlightOutcome = inFlight.then(
      () => "resolved",
      (error: unknown) => error,
    );
    const queuedOutcome = queued.then(
      () => "resolved",
      (error: unknown) => error,
    );

    await flush();
    expect(state.posted.length).toBe(1);

    await pool.close();

    expect(await inFlightOutcome).toBeInstanceOf(Error);
    expect(await queuedOutcome).toBeInstanceOf(Error);
    // The queued job never reached the worker.
    expect(state.posted.length).toBe(1);
  });
});
