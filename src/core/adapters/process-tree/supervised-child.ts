/**
 * A child process run under a wall-clock and a process-tree resident-memory
 * budget. A breach kills the whole tree and is reported as data, never thrown.
 *
 * Hosts the long-running toolchain child of the Rust codegraph (the rustc
 * call-site driver). Every host effect is injected (`SupervisedChildHost`);
 * `spawnSupervisedChild` and `sampleProcessTreeRssKb` bind them to node.
 */

import { spawn as spawnChild, spawnSync } from "node:child_process";

/** A running child whose whole tree can be killed. */
export interface SupervisedChild {
  readonly pid: number;
  /** Kill the child and every process it started. */
  killTree: () => void;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

export interface SupervisedChildSpawnOptions {
  env: Readonly<Record<string, string | undefined>>;
  onOutput: (chunk: string) => void;
  /** Working directory; the host's when absent. */
  cwd?: string;
}

/** Host effects the supervisor polls with. */
export interface SupervisedChildHost {
  /** Summed RSS (KiB) of `pid` and its descendants; undefined when unmeasurable. */
  sampleTreeRssKb: (pid: number) => number | undefined;
  clock: { now: () => number; every: (ms: number, tick: () => void) => () => void };
}

export interface SupervisedChildBudget {
  /** Names the child in breach details, e.g. `tea-rags-rustc-driver`. */
  label: string;
  timeoutSec: number;
  maxRssMb: number;
  /** Budget poll period. */
  pollMs: number;
}

export type SupervisedChildBreachReason = "timeout" | "rss";

export interface SupervisedChildRun {
  exitCode: number | null;
  breach?: { reason: SupervisedChildBreachReason; detail: string };
  wallMs: number;
  peakRssKb: number;
}

/**
 * Start the child (`launch`) and poll its budget until it exits. The wall clock
 * starts before `launch`, so spawn cost counts against the budget.
 */
export async function superviseChild(
  launch: () => SupervisedChild,
  budget: SupervisedChildBudget,
  host: SupervisedChildHost,
): Promise<SupervisedChildRun> {
  const started = host.clock.now();
  const child = launch();
  let breach: SupervisedChildRun["breach"];
  let peakRssKb = 0;
  const timeoutMs = budget.timeoutSec * 1000;
  const maxRssKb = budget.maxRssMb * 1024;
  const stop = host.clock.every(budget.pollMs, () => {
    if (breach) return;
    const elapsed = host.clock.now() - started;
    const rssKb = host.sampleTreeRssKb(child.pid);
    if (rssKb !== undefined) peakRssKb = Math.max(peakRssKb, rssKb);
    if (elapsed >= timeoutMs) {
      breach = { reason: "timeout", detail: `${budget.label} ran past ${budget.timeoutSec}s` };
    } else if (rssKb !== undefined && rssKb > maxRssKb) {
      breach = {
        reason: "rss",
        detail: `${budget.label} tree reached ${Math.round(rssKb / 1024)} MB (budget ${budget.maxRssMb} MB)`,
      };
    }
    if (breach) child.killTree();
  });
  try {
    const exit = await child.exited;
    return {
      exitCode: exit.code,
      ...(breach ? { breach } : {}),
      wallMs: host.clock.now() - started,
      peakRssKb,
    };
  } finally {
    stop();
  }
}

/**
 * The detached tree outlives the thread that spawned it: a terminated
 * enrichment worker fires no `exit` hook, and its wall-budget poller dies with
 * it. So the run is wrapped: `sh` starts the command in the background and a
 * watchdog blocks on the stdin pipe the host holds. EOF — the host thread or
 * process is gone, or the run settled and the host closed it — kills the whole
 * process group. fd 3 carries stdin past the background-job `/dev/null`
 * redirection; the watchdog's own output goes to `/dev/null` so it never holds
 * the host's pipes open.
 */
const HOST_WATCHDOG_SCRIPT =
  'exec 3<&0; (cat <&3 >/dev/null; kill -KILL 0) >/dev/null 2>&1 & "$@" </dev/null 3<&- & wait $!';

/**
 * How the child is launched. POSIX: under the `/bin/sh` watchdog, `$0` = `name`.
 * Windows has no `/bin/sh`: the command runs directly, without the watchdog, so
 * a terminated host thread leaves the child to its wall budget.
 */
export function supervisedChildInvocation(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
  name: string,
): { command: string; args: readonly string[]; watchdog: boolean } {
  if (platform === "win32") return { command, args, watchdog: false };
  return {
    command: "/bin/sh",
    args: ["-c", HOST_WATCHDOG_SCRIPT, name, command, ...args],
    watchdog: true,
  };
}

/** Spawn `command` in its own process group under the host watchdog; `name` labels the shell. */
export function spawnSupervisedChild(
  command: string,
  args: readonly string[],
  options: SupervisedChildSpawnOptions,
  name: string,
): SupervisedChild {
  const invocation = supervisedChildInvocation(process.platform, command, args, name);
  // Own process group, so the whole tree dies on a breach — and, run under
  // HOST_WATCHDOG_SCRIPT, dies with the thread that spawned it.
  const child = spawnChild(invocation.command, [...invocation.args], {
    env: options.env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    detached: invocation.watchdog,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", () => undefined);
  child.stdout.setEncoding("utf8").on("data", options.onOutput);
  child.stderr.setEncoding("utf8").on("data", options.onOutput);
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("error", (error) => {
      options.onOutput(`spawn failed: ${error.message}\n`);
      resolve({ code: null, signal: null });
    });
    child.once("close", (code, signal) => {
      // Releases the watchdog, which then reaps whatever the run left in its group.
      child.stdin.end();
      resolve({ code, signal });
    });
  });
  return {
    pid: child.pid ?? -1,
    exited,
    killTree: () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    },
  };
}

/** `ps` over every process; sums the RSS of `rootPid` and all its descendants. */
export function sampleProcessTreeRssKb(rootPid: number): number | undefined {
  if (rootPid <= 0) return undefined;
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined;
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const [pid, ppid, kb] = line.trim().split(/\s+/).map(Number);
    if (pid === undefined || ppid === undefined || kb === undefined || Number.isNaN(kb)) continue;
    rss.set(pid, kb);
    const siblings = children.get(ppid) ?? [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }
  if (!rss.has(rootPid)) return undefined;
  let total = 0;
  const queue = [rootPid];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    total += rss.get(pid) ?? 0;
    queue.push(...(children.get(pid) ?? []));
  }
  return total;
}

/** A `clock` bound to the real timers. */
export const systemSupervisorClock: SupervisedChildHost["clock"] = {
  now: () => Date.now(),
  every: (ms, tick) => {
    const handle = setInterval(tick, ms);
    return () => {
      clearInterval(handle);
    };
  },
};
