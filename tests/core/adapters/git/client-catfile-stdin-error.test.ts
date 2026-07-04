/**
 * Deterministic unit test for the cat-file batch readers' stdin-pipe error
 * handling (both createCatFileBatch and createCatFileBatchCheck).
 *
 * The real-git tests in client-catfile.test.ts deliberately use NO
 * child_process mock. This sibling file mocks `spawn` to drive the async
 * pipe-error path that is otherwise timing-dependent: when the git process
 * exits mid-write, writing to its stdin surfaces `EPIPE` asynchronously on the
 * pipe. Without an 'error' listener on stdin that error escapes as an UNCAUGHT
 * exception — vitest then fails the whole run (observed on Node 22.x in CI while
 * Node 24.x happened to avoid the timing). The mock reproduces the mechanism on
 * every Node version.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCatFileBatch, createCatFileBatchCheck } from "../../../../src/core/adapters/git/client.js";

// Auto-mock: every export becomes a vi.fn(). Only `spawn` is exercised here
// (the batch readers' one child_process entry point), so the readers under test
// get a fully controlled fake child; execFile* stay unused.
vi.mock("node:child_process");

const spawnMock = vi.mocked(spawn);

// A coded write error mirroring what Node emits when writing to a stdin whose
// read-end (the git process) has already gone away.
function pipeError(code: "EPIPE" | "ECONNRESET" | "ENOSPC"): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: "write", errno: -32 });
}

interface FakeChildOptions {
  /** Error emitted asynchronously on the stdin pipe when the reader writes to it. */
  stdinError?: NodeJS.ErrnoException;
  /** Whether the fake git process emits 'close' (process exit) after the write. */
  closeAfterWrite?: boolean;
}

type FakeStdin = EventEmitter & { write: (d: string) => boolean; end: () => void };
type FakeChild = EventEmitter & { stdout: EventEmitter; stdin: FakeStdin; kill: () => void };

function fakeChild(opts: FakeChildOptions): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  const stdin = new EventEmitter() as FakeStdin;
  stdin.write = (_d: string): boolean => {
    // Mirror the OS: the pipe error and the process exit surface asynchronously,
    // on later event-loop turns, after write() has already returned.
    if (opts.stdinError) setImmediate(() => stdin.emit("error", opts.stdinError));
    if (opts.closeAfterWrite) setImmediate(() => child.emit("close", 128, null));
    return false;
  };
  stdin.end = (): void => {};
  child.stdin = stdin;
  child.kill = (): void => {};
  return child;
}

// The two readers share the same lazy-spawn + stdin-write shape. Parametrize so
// both get identical pipe-error coverage; each exposes its request under a
// uniform `send(rev)` wrapper.
const READERS: { name: string; send: (path: string) => (rev: string) => Promise<unknown> }[] = [
  {
    name: "createCatFileBatch",
    send: (path) => {
      const reader = createCatFileBatch(path);
      return async (rev) => reader.read(rev, "foo");
    },
  },
  {
    name: "createCatFileBatchCheck",
    send: (path) => {
      const reader = createCatFileBatchCheck(path);
      return async (rev) => reader.check(rev);
    },
  },
];

describe.each(READERS)("$name stdin pipe error handling", ({ send }) => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it.each(["EPIPE", "ECONNRESET"] as const)(
    "swallows a %s broken-pipe symptom instead of crashing the run with an uncaught exception",
    async (code) => {
      // The git process exits mid-write (broken pipe) AND emits 'close'. The
      // pending request must reject via the 'close' path — the broken-pipe
      // symptom is swallowed. Before the fix, stdin had no 'error' listener, so
      // the pipe error surfaced as an uncaught exception that failed the CI run.
      spawnMock.mockReturnValue(fakeChild({ stdinError: pipeError(code), closeAfterWrite: true }) as never);

      const request = send("/irrelevant");
      await expect(request("deadbeef")).rejects.toThrow(/exited unexpectedly/);
      // Give the async pipe error a turn to fire and be handled (swallowed),
      // proving it does not bubble up as an unhandled error after settling.
      await new Promise((resolve) => setImmediate(resolve));
    },
  );

  it("routes a non-benign stdin pipe error to the pending request rejection", async () => {
    // A stdin write error that is NOT a broken-pipe teardown symptom (e.g.
    // ENOSPC) must fail the in-flight request loudly rather than be swallowed.
    spawnMock.mockReturnValue(fakeChild({ stdinError: pipeError("ENOSPC") }) as never);

    const request = send("/irrelevant");
    await expect(request("deadbeef")).rejects.toThrow(/ENOSPC/);
  });
});
