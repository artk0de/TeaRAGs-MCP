/**
 * ProcessWorkerRuntime — a forked worker whose parent channel is gone.
 *
 * The parent of a process-transport worker can vanish mid-request (SIGINT to a
 * stdio server while a read chunks a delta file through the chunker pool). The
 * worker must then leave quietly and promptly: no unhandled `'error'` event on
 * `process` (EPIPE / ERR_IPC_CHANNEL_CLOSED from `process.send`), no stack trace
 * on stderr, exit code 0 — while an unrelated `'error'` still surfaces.
 */

import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INIT_KEY,
  ProcessWorkerRuntime,
} from "../../../../../../src/core/domains/ingest/pipeline/infra/worker-runtime.js";

const RUNTIME_PATH = join(process.cwd(), "build/core/domains/ingest/pipeline/infra/worker-runtime.js");

/** Answers each request after `init.delayMs`, reporting receipt on stdout first. */
const SLOW_WORKER_SRC = `
import { createWorkerRuntime } from "${RUNTIME_PATH}";
const rt = createWorkerRuntime();
const init = await rt.init();
rt.onShutdown(() => process.exit(0));
rt.onRequest((req) => {
  process.stdout.write("got\\n");
  setTimeout(() => rt.respond({ echo: req.n }), init.delayMs);
});
`;

/** A parent that forks the slow worker, prints its pid, and sends one request. */
const PARENT_SRC = (workerPath: string, delayMs: number): string => `
import { fork } from "node:child_process";
const child = fork(${JSON.stringify(workerPath)}, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
child.send({ ${INIT_KEY}: { delayMs: ${delayMs} } });
child.send({ n: 1 });
process.stdout.write(String(child.pid) + "\\n");
setInterval(() => undefined, 1000);
`;

const DELAY_MS = 3000;

function collect(stream: NodeJS.ReadableStream | null): () => string {
  let text = "";
  stream?.on("data", (b: Buffer) => (text += b.toString()));
  return () => text;
}

async function waitFor(stream: NodeJS.ReadableStream | null, pattern: RegExp): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    stream?.on("data", (b: Buffer) => {
      text += b.toString();
      const m = pattern.exec(text);
      if (m) resolve(m[1] ?? m[0]);
    });
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ProcessWorkerRuntime — parent channel gone (via fork)", () => {
  const dir = mkdtempSync(join(tmpdir(), "wr-gone-"));
  const workerPath = join(dir, "slow-worker.mjs");
  writeFileSync(workerPath, SLOW_WORKER_SRC, "utf8");
  const parentPath = join(dir, "parent.mjs");
  writeFileSync(parentPath, PARENT_SRC(workerPath, DELAY_MS), "utf8");
  const spawned: ChildProcess[] = [];
  afterAll(() => {
    for (const c of spawned) c.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  it("exits 0 promptly with a clean stderr when the parent disconnects mid-request", async () => {
    const child = fork(workerPath, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    spawned.push(child);
    const stderr = collect(child.stderr);
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => {
        resolve({ code, signal });
      }),
    );
    child.send({ [INIT_KEY]: { delayMs: DELAY_MS } });
    child.send({ n: 1 });
    await waitFor(child.stdout, /got/);

    const t0 = performance.now();
    child.disconnect();
    const { code, signal } = await exited;
    const elapsed = performance.now() - t0;

    expect(stderr()).toBe("");
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(elapsed).toBeLessThan(DELAY_MS / 2);
  });

  it("leaves no orphan and no stack trace when the parent is SIGKILLed mid-request", async () => {
    const parent = fork(parentPath, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    spawned.push(parent);
    const stderr = collect(parent.stderr);
    const workerPid = Number(await waitFor(parent.stdout, /^(\d+)\n/));
    // Let the request reach the worker before pulling the parent away.
    await new Promise((r) => setTimeout(r, 300));

    parent.kill("SIGKILL");
    const t0 = performance.now();
    while (isAlive(workerPid) && performance.now() - t0 < DELAY_MS + 2000) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const elapsed = performance.now() - t0;
    // The worker's stderr is inherited through the dead parent's pipe — give it a tick to drain.
    await new Promise((r) => setTimeout(r, 100));

    expect(isAlive(workerPid)).toBe(false);
    expect(elapsed).toBeLessThan(DELAY_MS / 2);
    expect(stderr()).toBe("");
  });
});

/**
 * In-process: drive the runtime's `process` listeners directly. The exit hook is
 * injected so the vitest worker itself is never terminated.
 */
describe("ProcessWorkerRuntime — parent channel gone (in-process)", () => {
  // The vitest fork worker owns its own `'disconnect'` / `'error'` listeners on
  // this very `process`; emitting those events must reach the runtime's
  // listeners alone, so the host's are parked for the duration of each test.
  const watched = ["error", "disconnect", "message"] as const;
  type Listener = (...args: unknown[]) => void;
  let parked: Map<string, Listener[]>;

  beforeEach(() => {
    parked = new Map(watched.map((e) => [e, process.listeners(e as "message") as Listener[]]));
    for (const e of ["error", "disconnect"] as const) process.removeAllListeners(e);
  });
  afterEach(() => {
    for (const e of watched) {
      const host = parked.get(e) ?? [];
      for (const l of process.listeners(e as "message") as Listener[]) {
        if (!host.includes(l)) process.off(e, l);
      }
      for (const l of host) {
        if (!(process.listeners(e as "message") as Listener[]).includes(l)) process.on(e as "message", l);
      }
    }
  });

  async function initialised(): Promise<{ gone: number[] }> {
    const calls = { gone: [] as number[] };
    const rt = new ProcessWorkerRuntime<unknown, unknown>(() => calls.gone.push(1));
    const ready = rt.init();
    process.emit("message", { [INIT_KEY]: {} }, null);
    await ready;
    return calls;
  }

  function codedError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`write ${code}`), { code });
  }

  it.each(["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED"])(
    "treats a %s 'error' from process.send as the parent leaving",
    async (code) => {
      const calls = await initialised();

      expect(() => process.emit("error" as "message", codedError(code), null)).not.toThrow();
      expect(calls.gone).toEqual([1]);
    },
  );

  it("treats the IPC 'disconnect' as the parent leaving, once", async () => {
    const calls = await initialised();

    process.emit("disconnect");
    process.emit("error" as "message", codedError("EPIPE"), null);

    expect(calls.gone).toEqual([1]);
  });

  it("rethrows an unrelated 'error' instead of swallowing it", async () => {
    const calls = await initialised();
    const unrelated = codedError("EACCES");

    expect(() => process.emit("error" as "message", unrelated, null)).toThrow(unrelated);
    expect(calls.gone).toEqual([]);
  });

  it("answers over the channel while the parent is there, and sends nothing once it left", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "send");
    const send = vi.fn(() => true);
    Object.defineProperty(process, "send", { value: send, configurable: true, writable: true });
    try {
      const rt = new ProcessWorkerRuntime<unknown, unknown>(() => undefined);
      const ready = rt.init();
      process.emit("message", { [INIT_KEY]: {} }, null);
      await ready;

      rt.respond({ n: 1 });
      process.emit("disconnect");
      rt.respond({ n: 2 });

      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith({ n: 1 });
    } finally {
      if (original) Object.defineProperty(process, "send", original);
      else Reflect.deleteProperty(process, "send");
    }
  });

  it("by default leaves with exit code 0 when the parent is gone", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const rt = new ProcessWorkerRuntime<unknown, unknown>();
      const ready = rt.init();
      process.emit("message", { [INIT_KEY]: {} }, null);
      await ready;

      process.emit("disconnect");

      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
    }
  });
});
