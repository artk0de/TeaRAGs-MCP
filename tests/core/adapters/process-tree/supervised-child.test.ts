import { spawnSync } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  sampleProcessTreeRssKb,
  spawnSupervisedChild,
  superviseChild,
  supervisedChildInvocation,
  systemSupervisorClock,
  type SupervisedChild,
  type SupervisedChildHost,
} from "../../../../src/core/adapters/process-tree/supervised-child.js";

vi.mock("node:child_process", async () => {
  const actual = await import("node:child_process");
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const BUDGET = { label: "fake-driver", timeoutSec: 10, maxRssMb: 1, pollMs: 50 };

/** A manual clock: `advance` moves time, `tick` runs the poll callback once. */
function manualHost(rssKb: (pid: number) => number | undefined): {
  host: SupervisedChildHost;
  advance: (ms: number) => void;
  tick: () => void;
  stopped: () => boolean;
} {
  let now = 1000;
  let callback: (() => void) | undefined;
  let stopped = false;
  return {
    host: {
      sampleTreeRssKb: rssKb,
      clock: {
        now: () => now,
        every: (_ms, tick) => {
          callback = tick;
          return () => {
            stopped = true;
          };
        },
      },
    },
    advance: (ms) => {
      now += ms;
    },
    tick: () => callback?.(),
    stopped: () => stopped,
  };
}

function fakeChild(): { child: SupervisedChild; exit: (code: number | null) => void; kills: () => number } {
  let kills = 0;
  let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => undefined;
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  return {
    child: {
      pid: 4242,
      exited,
      killTree: () => {
        kills++;
      },
    },
    exit: (code) => {
      resolveExit({ code, signal: null });
    },
    kills: () => kills,
  };
}

describe("superviseChild", () => {
  it("reports a clean exit with the peak RSS seen and releases the poller", async () => {
    const clock = manualHost(() => 512);
    const fake = fakeChild();
    const run = superviseChild(() => fake.child, BUDGET, clock.host);
    clock.advance(200);
    clock.tick();
    fake.exit(0);
    const result = await run;
    expect(result).toEqual({ exitCode: 0, wallMs: 200, peakRssKb: 512 });
    expect(result.breach).toBeUndefined();
    expect(fake.kills()).toBe(0);
    expect(clock.stopped()).toBe(true);
  });

  it("kills the tree and reports a timeout breach once the wall budget is spent", async () => {
    const clock = manualHost(() => undefined);
    const fake = fakeChild();
    const run = superviseChild(() => fake.child, BUDGET, clock.host);
    clock.advance(10_000);
    clock.tick();
    // A later poll after the breach is a no-op: the tree is killed once.
    clock.tick();
    fake.exit(null);
    const result = await run;
    expect(result.breach).toEqual({ reason: "timeout", detail: "fake-driver ran past 10s" });
    expect(result.exitCode).toBeNull();
    expect(result.peakRssKb).toBe(0);
    expect(fake.kills()).toBe(1);
  });

  it("kills the tree and reports an rss breach when the tree outgrows its budget", async () => {
    const clock = manualHost(() => 3 * 1024);
    const fake = fakeChild();
    const run = superviseChild(() => fake.child, BUDGET, clock.host);
    clock.tick();
    fake.exit(137);
    const result = await run;
    expect(result.breach).toEqual({ reason: "rss", detail: "fake-driver tree reached 3 MB (budget 1 MB)" });
    expect(result.peakRssKb).toBe(3 * 1024);
    expect(fake.kills()).toBe(1);
  });
});

describe("supervisedChildInvocation", () => {
  it("runs the command directly, unwatched, on win32", () => {
    expect(supervisedChildInvocation("win32", "cargo", ["check"], "name")).toEqual({
      command: "cargo",
      args: ["check"],
      watchdog: false,
    });
  });

  it("wraps the command in the /bin/sh host watchdog on posix", () => {
    const invocation = supervisedChildInvocation("linux", "cargo", ["check"], "driver");
    expect(invocation.command).toBe("/bin/sh");
    expect(invocation.watchdog).toBe(true);
    expect(invocation.args.slice(2)).toEqual(["driver", "cargo", "check"]);
  });
});

describe.skipIf(process.platform === "win32")("spawnSupervisedChild", () => {
  it("streams stdout and stderr to onOutput and resolves with the exit code", async () => {
    const chunks: string[] = [];
    const child = spawnSupervisedChild(
      process.execPath,
      ["-e", "process.stdout.write('out');process.stderr.write('err');process.exit(3)"],
      { env: { ...process.env }, onOutput: (chunk) => chunks.push(chunk), cwd: process.cwd() },
      "unit-child",
    );
    expect(child.pid).toBeGreaterThan(0);
    const exit = await child.exited;
    expect(exit.code).toBe(3);
    expect(chunks.join("")).toContain("out");
    expect(chunks.join("")).toContain("err");
  });

  it("kills the whole tree on killTree", async () => {
    const child = spawnSupervisedChild(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { env: { ...process.env }, onOutput: () => undefined },
      "unit-sleeper",
    );
    child.killTree();
    const exit = await child.exited;
    expect(exit.code === null || exit.code !== 0).toBe(true);
  });

  it("reports a spawn failure as output and a null exit, never a throw", async () => {
    const chunks: string[] = [];
    const child = spawnSupervisedChild(
      "/nonexistent-tea-rags-command",
      [],
      { env: {}, onOutput: (chunk) => chunks.push(chunk), cwd: "/nonexistent-tea-rags-cwd" },
      "unit-missing",
    );
    const exit = await child.exited;
    expect(exit).toEqual({ code: null, signal: null });
    expect(chunks.join("")).toContain("spawn failed");
    // killTree on a child that never started falls back instead of throwing.
    expect(() => {
      child.killTree();
    }).not.toThrow();
  });
});

describe("sampleProcessTreeRssKb", () => {
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
  });

  it("returns undefined for a non-positive pid without spawning ps", () => {
    expect(sampleProcessTreeRssKb(0)).toBeUndefined();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("returns undefined when ps fails", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "" } as ReturnType<typeof spawnSync>);
    expect(sampleProcessTreeRssKb(10)).toBeUndefined();
  });

  it("returns undefined when the root pid is not in the process table", () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: " 1 0 100\n 2 1 200\n" } as ReturnType<typeof spawnSync>);
    expect(sampleProcessTreeRssKb(99)).toBeUndefined();
  });

  it("sums the root and every descendant, skipping malformed rows and unrelated processes", () => {
    const table = [" 10 1 100", " 11 10 50", " 12 11 25", " 13 10 5", " 20 1 999", "garbage", " 30 1 abc", ""].join(
      "\n",
    );
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: table } as ReturnType<typeof spawnSync>);
    expect(sampleProcessTreeRssKb(10)).toBe(180);
  });
});

describe("systemSupervisorClock", () => {
  it("ticks on the interval until the returned stop is called", async () => {
    let ticks = 0;
    const stop = systemSupervisorClock.every(5, () => {
      ticks++;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop();
    const seen = ticks;
    expect(seen).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ticks).toBe(seen);
    expect(systemSupervisorClock.now()).toBeGreaterThan(0);
  });
});
