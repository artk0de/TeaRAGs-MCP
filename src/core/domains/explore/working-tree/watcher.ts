/**
 * `WorkingTreeWatcher` — keeps an addressed working tree's delta warm between
 * requests in the long-lived server (spec "Watcher"). One recursive fs watch per
 * tree root; file events under `.git` or rejected by the ingest filter are
 * dropped, the rest are debounced into a single `onSettled(root)` call
 * `debounceMs` after the LAST event. `onSettled` never overlaps itself for one
 * root: a debounce that fires while a run is in flight is coalesced into one
 * rerun after it finishes.
 *
 * A root stops being watched when it disappears (watcher `ENOENT`, a rename
 * naming the root, or a failed existence check at debounce time), after
 * `idleMs` without a `watch`/`touch` of it, on any other platform watcher error
 * (`EMFILE`, `ENOSPC` — logged; requests still warm on demand), on `unwatch`,
 * or on `close`. Every timer is unref'd, so the watcher never keeps a process
 * alive. Nothing here throws: watch failures and `onSettled` rejections are
 * logged and swallowed.
 */
import { watch as fsWatch } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, sep } from "node:path";

export const WORKING_TREE_WATCH_DEBOUNCE_MS = 2000;
export const WORKING_TREE_WATCH_IDLE_MS = 30 * 60 * 1000;

/** The slice of `fs.FSWatcher` the watcher uses. */
export interface WorkingTreeFsWatchHandle {
  on: (event: "error", listener: (error: NodeJS.ErrnoException) => void) => unknown;
  close: () => void;
}

/**
 * Starts a recursive watch on `root`. `filename` is relative to `root`, or
 * `null` when the platform does not name the changed entry. May throw
 * synchronously (e.g. `ENOENT`, `EMFILE`).
 */
export type WorkingTreeFsWatch = (
  root: string,
  listener: (eventType: string, filename: string | null) => void,
) => WorkingTreeFsWatchHandle;

export interface WorkingTreeWatchTimerHandle {
  unref?: () => unknown;
}

export interface WorkingTreeWatchTimers {
  setTimeout: (callback: () => void, ms: number) => WorkingTreeWatchTimerHandle;
  clearTimeout: (handle: WorkingTreeWatchTimerHandle) => void;
}

export interface WorkingTreeWatcherDeps {
  /** Called once a burst of relevant changes in `root` has settled. */
  onSettled: (root: string) => void | Promise<void>;
  /** Builds the ingest filter for `root`; a rejected path never wakes the watcher. */
  accepts?: (root: string) => Promise<(relativePath: string) => boolean>;
  watch?: WorkingTreeFsWatch;
  exists?: (root: string) => Promise<boolean>;
  timers?: WorkingTreeWatchTimers;
  debounceMs?: number;
  idleMs?: number;
  /** Debug sink. */
  log?: (message: string) => void;
}

const defaultFsWatch: WorkingTreeFsWatch = (root, listener) =>
  fsWatch(root, { recursive: true }, (eventType, filename) => {
    listener(eventType, filename === null ? null : String(filename));
  });

async function defaultExists(root: string): Promise<boolean> {
  try {
    return (await stat(root)).isDirectory();
  } catch {
    return false;
  }
}

const defaultTimers: WorkingTreeWatchTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  },
};

interface WatchedTree {
  readonly root: string;
  readonly handle: WorkingTreeFsWatchHandle;
  /** `undefined` while the filter loads: every path counts until then. */
  accepts?: (relativePath: string) => boolean;
  debounce?: WorkingTreeWatchTimerHandle;
  idle?: WorkingTreeWatchTimerHandle;
  running: boolean;
  rerun: boolean;
  stopped: boolean;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const { code } = error as NodeJS.ErrnoException;
    return code ? `${code} ${error.message}` : error.message;
  }
  return String(error);
}

function isUnderGit(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).includes(".git");
}

export class WorkingTreeWatcher {
  private readonly trees = new Map<string, WatchedTree>();
  private readonly onSettled: WorkingTreeWatcherDeps["onSettled"];
  private readonly accepts?: WorkingTreeWatcherDeps["accepts"];
  private readonly fsWatch: WorkingTreeFsWatch;
  private readonly exists: (root: string) => Promise<boolean>;
  private readonly timers: WorkingTreeWatchTimers;
  private readonly debounceMs: number;
  private readonly idleMs: number;
  private readonly log: (message: string) => void;
  private closed = false;

  constructor(deps: WorkingTreeWatcherDeps) {
    this.onSettled = deps.onSettled;
    this.accepts = deps.accepts;
    this.fsWatch = deps.watch ?? defaultFsWatch;
    this.exists = deps.exists ?? defaultExists;
    this.timers = deps.timers ?? defaultTimers;
    this.debounceMs = deps.debounceMs ?? WORKING_TREE_WATCH_DEBOUNCE_MS;
    this.idleMs = deps.idleMs ?? WORKING_TREE_WATCH_IDLE_MS;
    this.log = deps.log ?? (() => undefined);
  }

  /** Starts watching `root` (idempotent) and marks it viewed: resets its idle clock. */
  watch(root: string): void {
    if (this.closed) return;
    const watched = this.trees.get(root);
    if (watched) {
      this.armIdle(watched);
      return;
    }
    let handle: WorkingTreeFsWatchHandle;
    try {
      handle = this.fsWatch(root, (eventType, filename) => {
        this.onEvent(root, eventType, filename);
      });
    } catch (error) {
      this.log(`[WorkingTreeWatcher] cannot watch ${root}: ${describeError(error)}`);
      return;
    }
    const tree: WatchedTree = { root, handle, running: false, rerun: false, stopped: false };
    this.trees.set(root, tree);
    handle.on("error", (error) => {
      this.stop(tree, error.code === "ENOENT" ? "root removed" : `watcher error ${describeError(error)}`);
    });
    this.armIdle(tree);
    this.loadFilter(tree);
  }

  /** Resets the idle clock of an already watched root; no-op otherwise. */
  touch(root: string): void {
    const tree = this.trees.get(root);
    if (tree) this.armIdle(tree);
  }

  unwatch(root: string): void {
    const tree = this.trees.get(root);
    if (tree) this.stop(tree, "unwatched");
  }

  isWatching(root: string): boolean {
    return this.trees.has(root);
  }

  /** Stops every root; pending debounces never fire, later `watch` calls are no-ops. */
  close(): void {
    this.closed = true;
    for (const tree of [...this.trees.values()]) this.stop(tree, "closed");
  }

  private loadFilter(tree: WatchedTree): void {
    if (!this.accepts) return;
    this.accepts(tree.root).then(
      (accepts) => {
        tree.accepts = accepts;
      },
      (error: unknown) => {
        this.log(
          `[WorkingTreeWatcher] ingest filter for ${tree.root} failed, watching all paths: ${describeError(error)}`,
        );
      },
    );
  }

  private onEvent(root: string, eventType: string, filename: string | null): void {
    const tree = this.trees.get(root);
    if (!tree || tree.stopped) return;
    if (filename !== null && filename !== "") {
      const relativePath = sep === "/" ? filename : filename.split(sep).join("/");
      // An event naming the root itself is about the root, not its content:
      // macOS FSEvents emits one (`change`) when the watch starts and one
      // (`rename`) when the root is removed. Only its existence is in question.
      if (relativePath === basename(root)) {
        this.stopIfGone(tree).catch((error: unknown) => {
          this.log(`[WorkingTreeWatcher] existence check for ${root} failed: ${describeError(error)}`);
        });
        return;
      }
      if (isUnderGit(relativePath)) return;
      if (tree.accepts && !tree.accepts(relativePath)) return;
    }
    this.armDebounce(tree);
  }

  private armIdle(tree: WatchedTree): void {
    if (tree.idle) this.timers.clearTimeout(tree.idle);
    tree.idle = this.arm(() => {
      this.stop(tree, "idle");
    }, this.idleMs);
  }

  private armDebounce(tree: WatchedTree): void {
    if (tree.debounce) this.timers.clearTimeout(tree.debounce);
    tree.debounce = this.arm(() => {
      tree.debounce = undefined;
      this.settle(tree);
    }, this.debounceMs);
  }

  private arm(callback: () => void, ms: number): WorkingTreeWatchTimerHandle {
    const handle = this.timers.setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  }

  private settle(tree: WatchedTree): void {
    if (tree.stopped) return;
    if (tree.running) {
      tree.rerun = true;
      return;
    }
    tree.running = true;
    void this.run(tree).finally(() => {
      tree.running = false;
      if (tree.rerun && !tree.stopped) {
        tree.rerun = false;
        this.settle(tree);
      }
    });
  }

  private async run(tree: WatchedTree): Promise<void> {
    try {
      if (await this.stopIfGone(tree)) return;
      if (tree.stopped) return;
      await this.onSettled(tree.root);
    } catch (error) {
      this.log(`[WorkingTreeWatcher] onSettled for ${tree.root} failed: ${describeError(error)}`);
    }
  }

  /** Stops `tree` when its root no longer exists; resolves whether it did. */
  private async stopIfGone(tree: WatchedTree): Promise<boolean> {
    if (await this.exists(tree.root)) return false;
    this.stop(tree, "root removed");
    return true;
  }

  private stop(tree: WatchedTree, reason: string): void {
    if (tree.stopped) return;
    tree.stopped = true;
    tree.rerun = false;
    if (tree.debounce) this.timers.clearTimeout(tree.debounce);
    if (tree.idle) this.timers.clearTimeout(tree.idle);
    tree.debounce = undefined;
    tree.idle = undefined;
    if (this.trees.get(tree.root) === tree) this.trees.delete(tree.root);
    try {
      tree.handle.close();
    } catch (error) {
      this.log(`[WorkingTreeWatcher] closing ${tree.root} failed: ${describeError(error)}`);
    }
    this.log(`[WorkingTreeWatcher] stopped ${tree.root}: ${reason}`);
  }
}
