/**
 * `WorkingTreeChangeClock` — the long-lived server's proof that a working tree
 * has not changed since its last measurement, so the delta reader can answer it
 * without running `git status` (bd tea-rags-mcp-4qdj0: on a 51k-file tree that
 * one spawn was ~0.8 s of every read, whatever the answer's size).
 *
 * One recursive fs watch per git toplevel. Every event that can move the delta
 * — any working-file path, a null filename, and inside a git dir only `HEAD`,
 * `index`, `packed-refs` and `refs/**` — moves the tree's generation. Object
 * writes, logs, locks and other git churn do not.
 *
 * A read first passes a BARRIER, the way git's own fsmonitor syncs: the clock
 * writes a uniquely named, empty cookie file into `<toplevel>/.git/` and waits
 * for that cookie's event. One watch is one FSEvents stream, delivered in
 * order, so once the cookie's event arrives every event before the read has
 * been counted; only then is the generation answered. No TTL: an edit is seen
 * on the very next read. The barrier costs the platform's event latency (~50 ms
 * on macOS), not a git spawn. A stream that is not live yet loses events, so an
 * unechoed barrier writes a fresh cookie every `remarkMs`; any of them echoing
 * proves the order, since all were written after the read began. Cookies are
 * removed once the barrier settles.
 *
 * `undefined` = the clock cannot vouch and the caller measures: an unsupported
 * platform (only darwin's FSEvents ordering is relied on), a tree that is not a
 * main checkout (a linked worktree keeps its git state outside its tree, where
 * no in-tree cookie can order it), a watch that cannot start or errored, a
 * cookie that cannot be written, or a barrier that times out — the tree is then
 * dropped, and after `WORKING_TREE_BARRIER_MISSES_KEPT` misses in a row never
 * watched again. Never throws. At most `treesKept` trees are watched; the least
 * recently read one is closed first.
 */
import { watch as fsWatch, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";

import type { WorkingTreeFsWatch, WorkingTreeFsWatchHandle } from "./watcher.js";

export const WORKING_TREE_BARRIER_TIMEOUT_MS = 2000;
export const WORKING_TREE_BARRIER_REMARK_MS = 100;
export const WORKING_TREE_BARRIER_MISSES_KEPT = 3;
export const WORKING_TREE_CLOCK_TREES_KEPT = 16;

const COOKIE_PREFIX = "tea-rags-clock-";

export interface WorkingTreeChangeClockDeps {
  /** Whether the platform's watch delivers one dir's events in order. Default: darwin. */
  supported?: boolean;
  watch?: WorkingTreeFsWatch;
  /** Creates an empty cookie file at `path`. */
  writeCookie?: (path: string) => Promise<void>;
  removeCookie?: (path: string) => Promise<void>;
  /** Whether `gitToplevel` is a main checkout (`.git` is a directory). */
  isMainCheckout?: (gitToplevel: string) => boolean;
  barrierTimeoutMs?: number;
  remarkMs?: number;
  treesKept?: number;
  /** Debug sink. */
  log?: (message: string) => void;
}

interface ClockedTree {
  readonly toplevel: string;
  handle?: WorkingTreeFsWatchHandle;
  generation: number;
  closed: boolean;
  /** Watch-relative paths of the cookies the waiting barrier accepts. */
  readonly echoes: Set<string>;
  release?: () => void;
  /** The barrier not yet issued: every read arriving now shares it. */
  queued?: Promise<boolean>;
  /** The barrier issued last, still waiting or done. */
  inflight?: Promise<boolean>;
}

const GIT_STATE_FILES = new Set(["HEAD", "index", "packed-refs"]);

/**
 * Whether an event at the watch-relative `relativePath` can move the delta.
 * Inside a `.git` dir (the tree's own or a nested repository's) only HEAD, the
 * index and refs do.
 */
export function isWorkingTreeStateEvent(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  const gitAt = segments.indexOf(".git");
  if (gitAt === -1) return true;
  const trailing = segments.slice(gitAt + 1);
  return trailing.includes("refs") || GIT_STATE_FILES.has(trailing.at(-1) ?? "");
}

const defaultFsWatch: WorkingTreeFsWatch = (root, listener) =>
  fsWatch(root, { recursive: true }, (eventType, filename) => {
    listener(eventType, filename === null ? null : String(filename));
  });

function isMainCheckout(gitToplevel: string): boolean {
  try {
    return statSync(join(gitToplevel, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WorkingTreeChangeClock {
  private readonly trees = new Map<string, ClockedTree>();
  /** Consecutive barrier misses per toplevel, across re-watches. */
  private readonly misses = new Map<string, number>();
  /** Shared across trees, so a re-watched tree never repeats an old generation. */
  private tick = 0;
  private cookies = 0;
  private closed = false;

  constructor(private readonly deps: WorkingTreeChangeClockDeps = {}) {}

  /** The tree's generation once every event before this call is counted; `undefined` = measure. */
  async settledGeneration(gitToplevel: string): Promise<number | undefined> {
    if (this.closed || !(this.deps.supported ?? process.platform === "darwin")) return undefined;
    if ((this.misses.get(gitToplevel) ?? 0) >= WORKING_TREE_BARRIER_MISSES_KEPT) return undefined;
    const tree = this.treeOf(gitToplevel);
    if (!tree) return undefined;
    let passed: boolean;
    try {
      passed = await this.barrier(tree);
    } catch (error) {
      this.stop(tree, `barrier cookie failed: ${describeError(error)}`);
      return undefined;
    }
    if (tree.closed) return undefined;
    if (passed) {
      this.misses.delete(gitToplevel);
      return tree.generation;
    }
    this.misses.set(gitToplevel, (this.misses.get(gitToplevel) ?? 0) + 1);
    this.stop(tree, "barrier event missed");
    return undefined;
  }

  /** Closes every watch; the clock vouches for nothing afterwards. */
  close(): void {
    this.closed = true;
    for (const tree of [...this.trees.values()]) this.stop(tree, "clock closed");
  }

  private treeOf(gitToplevel: string): ClockedTree | undefined {
    const watchedTree = this.trees.get(gitToplevel);
    if (watchedTree) {
      this.trees.delete(gitToplevel);
      this.trees.set(gitToplevel, watchedTree);
      return watchedTree;
    }
    if (!(this.deps.isMainCheckout ?? isMainCheckout)(gitToplevel)) return undefined;
    const tree: ClockedTree = { toplevel: gitToplevel, generation: ++this.tick, closed: false, echoes: new Set() };
    try {
      tree.handle = (this.deps.watch ?? defaultFsWatch)(gitToplevel, (_eventType, filename) => {
        this.onEvent(tree, filename);
      });
    } catch (error) {
      this.log(`[WorkingTreeChangeClock] cannot watch ${gitToplevel}: ${describeError(error)}`);
      return undefined;
    }
    tree.handle.on("error", (error) => {
      this.stop(tree, `watcher error ${describeError(error)}`);
    });
    this.trees.set(gitToplevel, tree);
    const kept = this.deps.treesKept ?? WORKING_TREE_CLOCK_TREES_KEPT;
    for (const [, oldest] of this.trees) {
      if (this.trees.size <= kept) break;
      this.stop(oldest, "least recently read beyond the cap");
    }
    return tree;
  }

  private onEvent(tree: ClockedTree, filename: string | null): void {
    if (tree.closed) return;
    const relativePath = filename === null ? null : sep === "/" ? filename : filename.split(sep).join("/");
    if (relativePath !== null && tree.echoes.has(relativePath)) {
      const { release } = tree;
      tree.echoes.clear();
      tree.release = undefined;
      release?.();
      return;
    }
    if (relativePath === null || relativePath === "" || isWorkingTreeStateEvent(relativePath)) {
      tree.generation = ++this.tick;
    }
  }

  /** Resolves `true` once a cookie written after this call has echoed. */
  private async barrier(tree: ClockedTree): Promise<boolean> {
    if (tree.queued) return tree.queued;
    const prior = tree.inflight ?? Promise.resolve(true);
    const queued = prior.then(async () => {
      tree.queued = undefined;
      const issued = this.issue(tree);
      tree.inflight = issued.catch(() => false);
      return issued;
    });
    tree.queued = queued;
    return queued;
  }

  private async issue(tree: ClockedTree): Promise<boolean> {
    const written: string[] = [];
    const timers: ReturnType<typeof setTimeout>[] = [];
    const arm = (callback: () => void, ms: number): void => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      timers.push(timer);
    };
    let fail: (error: unknown) => void = () => undefined;
    const settled = new Promise<boolean>((resolve, reject) => {
      tree.release = () => {
        resolve(true);
      };
      fail = reject;
      arm(() => {
        resolve(false);
      }, this.deps.barrierTimeoutMs ?? WORKING_TREE_BARRIER_TIMEOUT_MS);
    });
    const mark = async (): Promise<void> => {
      const name = `${COOKIE_PREFIX}${process.pid}-${this.cookies++}`;
      tree.echoes.add(`.git/${name}`);
      const path = join(tree.toplevel, ".git", name);
      written.push(path);
      await (this.deps.writeCookie ?? (async (cookie: string) => writeFile(cookie, "")))(path);
    };
    const remark = (): void => {
      arm(() => {
        if (tree.release === undefined || tree.closed) return;
        mark().then(remark, fail);
      }, this.deps.remarkMs ?? WORKING_TREE_BARRIER_REMARK_MS);
    };
    try {
      await mark();
      remark();
      return await settled;
    } finally {
      for (const timer of timers) clearTimeout(timer);
      tree.echoes.clear();
      tree.release = undefined;
      const removeCookie = this.deps.removeCookie ?? (async (cookie: string) => rm(cookie, { force: true }));
      for (const path of written) {
        removeCookie(path).catch((error: unknown) => {
          this.log(`[WorkingTreeChangeClock] removing ${path} failed: ${describeError(error)}`);
        });
      }
    }
  }

  private stop(tree: ClockedTree, reason: string): void {
    if (tree.closed) return;
    tree.closed = true;
    if (this.trees.get(tree.toplevel) === tree) this.trees.delete(tree.toplevel);
    // A barrier still waiting resolves now; `settledGeneration` sees the closed tree.
    tree.release?.();
    try {
      tree.handle?.close();
    } catch (error) {
      this.log(`[WorkingTreeChangeClock] closing ${tree.toplevel} failed: ${describeError(error)}`);
    }
    this.log(`[WorkingTreeChangeClock] stopped ${tree.toplevel}: ${reason}`);
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}
