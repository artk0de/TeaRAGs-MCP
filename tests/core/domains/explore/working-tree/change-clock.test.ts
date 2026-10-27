/**
 * `WorkingTreeChangeClock`: the long-lived server's proof that a working tree
 * did not change since its last measurement (bd tea-rags-mcp-4qdj0). One
 * recursive fs watch per main-checkout git toplevel; every relevant event moves
 * the tree's generation. A read first passes a barrier — the clock writes a
 * uniquely named cookie into `.git/` and waits for that cookie's own event, so
 * every event before the read has been delivered — and only then answers the
 * generation. `undefined` = the clock cannot vouch; the caller measures.
 * `fs.watch` and the cookie writes are faked here; the darwin-only
 * block at the end runs the real FSEvents watcher on a scratch directory.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  WorkingTreeChangeClock,
  type WorkingTreeChangeClockDeps,
  type WorkingTreeFsWatch,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

class FakeFsWatchHandle extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

interface FakeWatch {
  dir: string;
  emit: (eventType: string, filename: string | null) => void;
  handle: FakeFsWatchHandle;
}

interface Harness {
  clock: WorkingTreeChangeClock;
  watches: FakeWatch[];
  /** Every path the clock marked (cookie written or atime touched), in order. */
  marks: string[];
}

const ROOT = "/repo/main";
const OTHER_ROOT = "/repo/other";

/**
 * A fake platform: `watch` records handles; a mark delivers its path's event,
 * relative to the open watch that contains it, on the next macrotask — after
 * every event emitted before it, as one FSEvents stream does. `silentMarks`
 * drops those events.
 */
function harness(
  overrides: Partial<WorkingTreeChangeClockDeps> = {},
  options: { silentMarks?: boolean; droppedMarks?: number } = {},
): Harness {
  const watches: FakeWatch[] = [];
  const marks: string[] = [];
  const watch: WorkingTreeFsWatch = (dir, listener) => {
    const handle = new FakeFsWatchHandle();
    watches.push({ dir, emit: listener, handle });
    return handle;
  };
  const mark = async (path: string): Promise<void> => {
    marks.push(path);
    if (options.silentMarks || marks.length <= (options.droppedMarks ?? 0)) return;
    const target = watches.filter((w) => !w.handle.closed && path.startsWith(`${w.dir}/`)).at(-1);
    if (target) {
      setImmediate(() => {
        target.emit("rename", relative(target.dir, path));
      });
    }
  };
  const clock = new WorkingTreeChangeClock({
    supported: true,
    watch,
    writeCookie: mark,
    removeCookie: async () => undefined,
    isMainCheckout: () => true,
    barrierTimeoutMs: 50,
    ...overrides,
  });
  return { clock, watches, marks };
}

describe("WorkingTreeChangeClock", () => {
  let current: Harness | undefined;
  afterEach(() => {
    current?.clock.close();
    current = undefined;
  });

  it("should answer the same generation for a tree with no event between two reads", async () => {
    current = harness();
    const first = await current.clock.settledGeneration(ROOT);
    const second = await current.clock.settledGeneration(ROOT);

    expect(first).toBeTypeOf("number");
    expect(second).toBe(first);
    expect(current.watches.map((w) => w.dir)).toEqual([ROOT]);
    // A fresh, uniquely named cookie in the git dir per read.
    expect(current.marks).toHaveLength(2);
    expect(current.marks.every((path) => path.startsWith(`${ROOT}/.git/`))).toBe(true);
    expect(new Set(current.marks).size).toBe(2);
  });

  it("should move the generation on a working-file event", async () => {
    current = harness();
    const first = await current.clock.settledGeneration(ROOT);

    current.watches[0]?.emit("change", "app/models/user.rb");
    const second = await current.clock.settledGeneration(ROOT);

    expect(second).not.toBe(first);
  });

  it.each([
    ["HEAD move (branch switch)", ".git/HEAD"],
    ["index rewrite (stage, commit)", ".git/index"],
    ["branch tip (commit)", ".git/refs/heads/main"],
    ["packed refs", ".git/packed-refs"],
    ["an unnamed change", null],
  ])("should move the generation on %s", async (_label, filename) => {
    current = harness();
    const first = await current.clock.settledGeneration(ROOT);

    current.watches[0]?.emit("rename", filename);
    const second = await current.clock.settledGeneration(ROOT);

    expect(second).not.toBe(first);
  });

  it.each([".git/objects/ab/cdef0123", ".git/logs/HEAD.lock", ".git/FETCH_HEAD", ".git/index.lock"])(
    "should keep the generation on git-internal churn %s",
    async (filename) => {
      current = harness();
      const first = await current.clock.settledGeneration(ROOT);

      current.watches[0]?.emit("change", filename);
      const second = await current.clock.settledGeneration(ROOT);

      expect(second).toBe(first);
    },
  );

  it("should count an event delivered before the barrier's echo in that same read", async () => {
    current = harness();
    const first = current.clock.settledGeneration(ROOT);
    current.watches[0]?.emit("change", "lib/edited.rb");
    const firstGeneration = await first;
    const second = await current.clock.settledGeneration(ROOT);

    expect(second).toBe(firstGeneration);
  });

  it("should not release a barrier on an earlier read's late cookie echo", async () => {
    current = harness({}, { silentMarks: true });
    const read = current.clock.settledGeneration(ROOT);
    await new Promise((resolve) => setImmediate(resolve));
    // An old cookie's echo (another name) arrives while this read waits.
    current.watches[0]?.emit("rename", ".git/tea-rags-clock-0-0");

    expect(await read).toBeUndefined();
  });

  it("should write a fresh cookie while the stream is not live yet, and vouch once one echoes", async () => {
    current = harness({ remarkMs: 5 }, { droppedMarks: 2 });

    const generation = await current.clock.settledGeneration(ROOT);

    expect(generation).toBeTypeOf("number");
    expect(current.marks.length).toBeGreaterThanOrEqual(3);
  });

  it("should not vouch when the platform is unsupported, and watch nothing", async () => {
    current = harness({ supported: false });

    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
    expect(current.watches).toHaveLength(0);
  });

  it("should not vouch, and watch nothing, for a tree that is not a main checkout (linked worktree)", async () => {
    current = harness({ isMainCheckout: () => false });

    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
    expect(current.watches).toHaveLength(0);
    expect(current.marks).toHaveLength(0);
  });

  it("should not vouch when the watch cannot start", async () => {
    current = harness({
      watch: () => {
        throw Object.assign(new Error("EMFILE: too many open files"), { code: "EMFILE" });
      },
    });

    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
  });

  it("should not vouch after the watcher errors, then re-watch under a fresh generation", async () => {
    current = harness();
    const first = await current.clock.settledGeneration(ROOT);

    current.watches[0]?.handle.emit("error", Object.assign(new Error("boom"), { code: "EIO" }));
    expect(current.watches[0]?.handle.closed).toBe(true);
    const second = await current.clock.settledGeneration(ROOT);

    expect(current.watches).toHaveLength(2);
    expect(second).toBeTypeOf("number");
    expect(second).not.toBe(first);
  });

  it("should not vouch when the barrier event never arrives, and give the tree up after repeated misses", async () => {
    current = harness({}, { silentMarks: true });

    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
    expect(current.watches.every((w) => w.handle.closed)).toBe(true);

    const marked = current.marks.length;
    const watched = current.watches.length;
    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
    expect(current.marks).toHaveLength(marked);
    expect(current.watches).toHaveLength(watched);
  });

  it("should not vouch when the cookie cannot be written (root removed)", async () => {
    current = harness({
      writeCookie: async () => {
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      },
    });

    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
  });

  it("should close the least recently read tree beyond the cap", async () => {
    current = harness({ treesKept: 1 });
    await current.clock.settledGeneration(ROOT);
    await current.clock.settledGeneration(OTHER_ROOT);

    expect(current.watches.find((w) => w.dir === ROOT)?.handle.closed).toBe(true);
    expect(current.watches.find((w) => w.dir === OTHER_ROOT)?.handle.closed).toBe(false);
  });

  it("should close every watch on close and vouch for nothing after", async () => {
    current = harness();
    await current.clock.settledGeneration(ROOT);

    current.clock.close();

    expect(current.watches.every((w) => w.handle.closed)).toBe(true);
    expect(await current.clock.settledGeneration(ROOT)).toBeUndefined();
  });
});

describe.runIf(process.platform === "darwin")("WorkingTreeChangeClock on FSEvents", () => {
  let dir: string | undefined;
  let clock: WorkingTreeChangeClock | undefined;
  afterEach(() => {
    clock?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("should vouch for an untouched tree and see an edit, a new file and a HEAD move on the very next read", async () => {
    dir = mkdtempSync(join(tmpdir(), "change-clock-"));
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(dir, "tracked.rb"), "a\n");
    clock = new WorkingTreeChangeClock();

    const first = await clock.settledGeneration(dir);
    const quiet = await clock.settledGeneration(dir);
    writeFileSync(join(dir, "tracked.rb"), "b\n");
    const edited = await clock.settledGeneration(dir);
    writeFileSync(join(dir, "new.rb"), "c\n");
    const created = await clock.settledGeneration(dir);
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/other\n");
    const moved = await clock.settledGeneration(dir);
    clock.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(first).toBeTypeOf("number");
    expect(quiet).toBe(first);
    expect(edited).not.toBe(quiet);
    expect(created).not.toBe(edited);
    expect(moved).not.toBe(created);
    // Its cookies are removed once echoed.
    expect(readdirSync(join(dir, ".git")).filter((name) => name.startsWith("tea-rags-clock-"))).toEqual([]);
  });
});
