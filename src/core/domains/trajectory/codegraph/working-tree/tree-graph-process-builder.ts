/**
 * Spawner of the working-tree graph build (epic xi2r9, WTO-7): keeps ONE warm
 * child forked from the compiled `tree-graph-entry.js` under a heap ceiling,
 * sends it builds one at a time over IPC, and turns however each build ended
 * into a `WorkingTreeGraphBuildOutcome`.
 *
 * Warm, because a fresh child per build pays the fork, the module load and
 * every TypeScript parse again — measured ~2 s of a ~4 s seeded build after a
 * one-file edit. The child carries its parse caches from one build to the next
 * (see `tree-graph-entry.ts`); everything else is per build.
 *
 * The per-build contract is the cold child's: a build over its time budget is
 * SIGKILLed with its child (`timedOut`), a child that dies mid-build fails that
 * build with the same classification a cold child's exit got (`heapExhausted`,
 * `failed`), and the next build forks a fresh child. Builds queued behind a
 * killed child are dispatched to the fresh one — the death was the active
 * build's, not theirs. The child is retired when it sits idle for
 * {@link WORKING_TREE_GRAPH_CHILD_IDLE_MS}, when a build leaves its heap above
 * {@link WORKING_TREE_GRAPH_CHILD_RECYCLE_HEAP_FRACTION} of the ceiling, and
 * when a build asks for a different ceiling. An idle child holds no reference
 * on the parent's event loop: the parent exits as if it were not there, and the
 * child follows when its channel closes.
 *
 * It never throws for a child failure — a graph that could not be built makes
 * the reader degrade to the base graph with `degraded` naming why, which is a
 * product answer, not an error. Only a caller bug (a non-positive budget)
 * throws.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isDebug } from "../../../../infra/runtime.js";
import type { WorkingTreeGraphBuildInput, WorkingTreeGraphBuilt } from "./tree-graph-build.js";
import {
  isWorkingTreeGraphEntryReply,
  type WorkingTreeGraphEntryReply,
  type WorkingTreeGraphEntryRequest,
  type WorkingTreeGraphEntryShutdown,
} from "./tree-graph-protocol.js";

/**
 * The child entry — always the compiled JS in `build/`, like the chunker pool's
 * worker: `import.meta.url` names `src/…/tree-graph-process-builder.ts` under
 * vitest and `build/…/tree-graph-process-builder.js` in production, and node
 * cannot fork a `.ts` file, so the `src/` segment is remapped to `build/`.
 */
const TREE_GRAPH_ENTRY_PATH = fileURLToPath(new URL("./tree-graph-entry.js", import.meta.url)).replace(
  "/src/",
  "/build/",
);

/** How long a warm child may sit without a build before it is retired. */
export const WORKING_TREE_GRAPH_CHILD_IDLE_MS = 5 * 60_000;

/**
 * The share of its heap ceiling a child may still hold after a build and stay
 * warm. Above it the child is retired once the build is answered: what it holds
 * is retained parses plus garbage, and the next build's Program needs the room.
 */
export const WORKING_TREE_GRAPH_CHILD_RECYCLE_HEAP_FRACTION = 0.6;

/** How long a retired child gets to exit on its own before it is killed. */
const RETIRE_GRACE_MS = 5_000;

/** How much the child may spend on one build before it is killed. */
export interface WorkingTreeGraphBuildBudget {
  /** Wall-clock budget from dispatch to reply; SIGKILL past it. */
  timeoutMs: number;
  /** The child's V8 old-space ceiling (`--max-old-space-size`). */
  heapLimitMb: number;
}

/** How a forked tree build ended. Every variant but `built` means "serve the base graph". */
export type WorkingTreeGraphBuildOutcome =
  | { kind: "built"; graph: WorkingTreeGraphBuilt }
  | { kind: "failed"; reason: string }
  | { kind: "timedOut"; timeoutMs: number }
  | { kind: "heapExhausted"; heapLimitMb: number };

/** Lifecycle knobs; tests shorten them. */
export interface WorkingTreeGraphProcessBuilderOptions {
  /** Default {@link WORKING_TREE_GRAPH_CHILD_IDLE_MS}. */
  idleMs?: number;
  /** Default {@link WORKING_TREE_GRAPH_CHILD_RECYCLE_HEAP_FRACTION}. */
  recycleHeapFraction?: number;
}

/** Bytes of the child's stderr kept for a `failed` reason and the OOM check. */
const STDERR_TAIL_BYTES = 8192;

/** V8's fatal-OOM banner — what a heap exhaustion prints before it aborts. */
const HEAP_EXHAUSTED_PATTERN = /heap out of memory|Reached heap limit/i;

/** Exit code of a process killed by SIGABRT, which V8 raises on a fatal OOM. */
const SIGABRT_EXIT_CODE = 134;

interface QueuedBuild {
  input: WorkingTreeGraphBuildInput;
  budget: WorkingTreeGraphBuildBudget;
  resolve: (outcome: WorkingTreeGraphBuildOutcome) => void;
}

/** The build the child is running. */
interface ActiveBuild extends QueuedBuild {
  id: number;
  timer: NodeJS.Timeout;
  timedOut: boolean;
  processError: Error | undefined;
}

/** One forked child and what the builder tracks about it. */
interface WarmChild {
  process: ChildProcess;
  heapLimitMb: number;
  /** stderr since the current build was dispatched. */
  stderrTail: string;
  active: ActiveBuild | undefined;
  idleTimer: NodeJS.Timeout | undefined;
}

export class WorkingTreeGraphProcessBuilder {
  /** Builds waiting for the child, in arrival order. */
  private readonly queue: QueuedBuild[] = [];
  /** The live child serving builds, if any. A retired child is no longer here. */
  private warm: WarmChild | undefined;
  /** Every child forked and not yet closed — the serving one and any being retired. */
  private readonly running = new Set<ChildProcess>();
  private nextBuildId = 1;
  /** Why the last fork threw — the reason a build that could not get a child fails with. */
  private lastForkError: string | undefined;
  private readonly idleMs: number;
  private readonly recycleHeapFraction: number;

  /**
   * @param entryPath The compiled child entry; tests may point it elsewhere.
   * @param options Lifecycle knobs ({@link WorkingTreeGraphProcessBuilderOptions}).
   */
  constructor(
    private readonly entryPath: string = TREE_GRAPH_ENTRY_PATH,
    options: WorkingTreeGraphProcessBuilderOptions = {},
  ) {
    this.idleMs = options.idleMs ?? WORKING_TREE_GRAPH_CHILD_IDLE_MS;
    this.recycleHeapFraction = options.recycleHeapFraction ?? WORKING_TREE_GRAPH_CHILD_RECYCLE_HEAP_FRACTION;
  }

  /**
   * SIGKILL every child still running, synchronously — the warm one, busy or
   * idle, and any being retired — for a process that is exiting (bd
   * tea-rags-mcp-xi2r9, D6): an abandoned build would otherwise finish into a
   * staging dir nobody publishes. The build in flight settles as `failed` on
   * its child's `close`, like any death without a reply.
   */
  killInFlight(): void {
    for (const child of this.running) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  /**
   * Run one tree build in the warm child (forking it if none is up) once every
   * build queued before it has finished. Settles when the child replies or
   * dies; a reply leaves the child running for the next build.
   */
  async build(
    input: WorkingTreeGraphBuildInput,
    budget: WorkingTreeGraphBuildBudget,
  ): Promise<WorkingTreeGraphBuildOutcome> {
    if (!(budget.timeoutMs > 0) || !(budget.heapLimitMb > 0)) {
      throw new Error(`WorkingTreeGraphProcessBuilder: budget must be positive (got ${JSON.stringify(budget)})`);
    }
    return new Promise((resolve) => {
      this.queue.push({ input, budget, resolve });
      this.pump();
    });
  }

  /**
   * Retire the warm child and wait for every child to exit — the builder is
   * left with none, and a later build forks a fresh one. A build still running
   * is killed and settles `failed`, like {@link killInFlight}.
   */
  async close(): Promise<void> {
    // Awaited on `exit`, not `close`: a child retired through the channel may
    // never emit `close` in the parent, and exit is what the caller waits for.
    const closing = [...this.running].map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      });
    });
    const { warm } = this;
    if (warm?.active) warm.process.kill("SIGKILL");
    else if (warm) this.retire(warm);
    await Promise.all(closing);
  }

  /** Dispatch the next queued build if the child is free. */
  private pump(): void {
    if (this.warm?.active) return;
    const next = this.queue.shift();
    if (!next) return;
    const child = this.childFor(next.budget.heapLimitMb);
    if (!child) {
      next.resolve({ kind: "failed", reason: this.lastForkError ?? "tree-graph fork failed" });
      this.pump();
      return;
    }
    this.dispatch(child, next);
  }

  /** The warm child when it was forked with `heapLimitMb`; otherwise retire it and fork one that was. */
  private childFor(heapLimitMb: number): WarmChild | undefined {
    const floored = Math.floor(heapLimitMb);
    if (this.warm?.heapLimitMb === floored) return this.warm;
    if (this.warm) this.retire(this.warm);
    let child: ChildProcess;
    try {
      child = fork(this.entryPath, [], {
        // Replaces (not extends) the parent's execArgv: vitest's or a dev
        // loader's flags have no business in a plain-JS child.
        execArgv: [`--max-old-space-size=${String(floored)}`],
        env: childEnvironment(),
        // stdout is ignored, never inherited: the MCP server's stdout is the
        // protocol channel.
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
    } catch (err) {
      this.lastForkError = `tree-graph fork failed: ${(err as Error).message}`;
      return undefined;
    }
    const warm: WarmChild = {
      process: child,
      heapLimitMb: floored,
      stderrTail: "",
      active: undefined,
      idleTimer: undefined,
    };
    this.running.add(child);
    child.once("exit", () => {
      this.running.delete(child);
    });
    this.warm = warm;
    child.stderr?.on("data", (chunk: Buffer) => {
      // The parent's stderr is the MCP server's log — the child's lines reach
      // it only under DEBUG, like every other codegraph diagnostic.
      if (isDebug()) process.stderr.write(chunk);
      warm.stderrTail = (warm.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("message", (message: unknown) => {
      if (isWorkingTreeGraphEntryReply(message)) this.onReply(warm, message);
    });
    child.on("error", (err) => {
      if (warm.active) warm.active.processError ??= err;
    });
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.onClose(warm, code, signal);
    });
    return warm;
  }

  private dispatch(warm: WarmChild, build: QueuedBuild): void {
    if (warm.idleTimer) clearTimeout(warm.idleTimer);
    warm.idleTimer = undefined;
    warm.stderrTail = "";
    const id = this.nextBuildId++;
    const timer = setTimeout(() => {
      active.timedOut = true;
      warm.process.kill("SIGKILL");
    }, build.budget.timeoutMs);
    const active: ActiveBuild = { ...build, id, timer, timedOut: false, processError: undefined };
    warm.active = active;
    // A build in flight holds the parent open, as a cold child did; an idle
    // child does not (see `release`).
    holdParent(warm.process, true);
    const request: WorkingTreeGraphEntryRequest = { input: build.input, debug: isDebug(), id };
    warm.process.send(request, (err) => {
      if (err) active.processError ??= err;
    });
  }

  /** The child answered: settle the build and keep the child warm, or retire it. */
  private onReply(warm: WarmChild, reply: WorkingTreeGraphEntryReply): void {
    const { active } = warm;
    // Our own kill wins: a reply racing the timer is discarded and the build
    // settles `timedOut` on close — the budget is the contract.
    if (!active || active.timedOut || (reply.id !== undefined && reply.id !== active.id)) return;
    clearTimeout(active.timer);
    warm.active = undefined;
    active.resolve(
      classifyExit({
        budget: active.budget,
        reply,
        timedOut: false,
        processError: undefined,
        stderrTail: warm.stderrTail,
        code: null,
        signal: null,
      }),
    );
    const heapCeilingBytes = warm.heapLimitMb * 1024 * 1024;
    if (reply.heapUsedBytes !== undefined && reply.heapUsedBytes > this.recycleHeapFraction * heapCeilingBytes) {
      this.retire(warm);
    } else if (this.queue.length === 0) {
      this.release(warm);
    }
    this.pump();
  }

  /** The child is gone: fail the build it was running with its exit's classification; queued builds go to a fresh child. */
  private onClose(warm: WarmChild, code: number | null, signal: NodeJS.Signals | null): void {
    this.running.delete(warm.process);
    if (warm.idleTimer) clearTimeout(warm.idleTimer);
    if (this.warm === warm) this.warm = undefined;
    const { active } = warm;
    if (active) {
      clearTimeout(active.timer);
      warm.active = undefined;
      active.resolve(
        classifyExit({
          budget: active.budget,
          reply: undefined,
          timedOut: active.timedOut,
          processError: active.processError,
          stderrTail: warm.stderrTail,
          code,
          signal,
        }),
      );
    }
    this.pump();
  }

  /** Nothing queued: let the parent exit past this child, and retire it after the idle period. */
  private release(warm: WarmChild): void {
    holdParent(warm.process, false);
    warm.idleTimer = setTimeout(() => {
      if (!warm.active) this.retire(warm);
    }, this.idleMs);
    warm.idleTimer.unref();
  }

  /**
   * Stop sending builds to `warm` and let it exit: it is asked to over IPC and
   * exits on its own (a child exiting itself is what makes its `close` fire;
   * the parent disconnecting the channel leaves `close` pending). A child that
   * cannot be asked, or does not go within the grace, is killed.
   */
  private retire(warm: WarmChild): void {
    if (this.warm === warm) this.warm = undefined;
    if (warm.idleTimer) clearTimeout(warm.idleTimer);
    warm.idleTimer = undefined;
    holdParent(warm.process, false);
    const shutdown: WorkingTreeGraphEntryShutdown = { kind: "shutdown" };
    if (warm.process.connected) {
      warm.process.send(shutdown, (err) => {
        if (err) warm.process.kill("SIGKILL");
      });
    } else {
      warm.process.kill("SIGKILL");
    }
    const grace = setTimeout(() => {
      if (warm.process.exitCode === null && warm.process.signalCode === null) warm.process.kill("SIGKILL");
    }, RETIRE_GRACE_MS);
    grace.unref();
  }
}

/**
 * Whether `child` keeps the parent's event loop alive: its process handle, its
 * IPC channel and its stderr pipe each hold a reference until unref'd.
 */
function holdParent(child: ChildProcess, held: boolean): void {
  if (held) {
    child.ref();
    child.channel?.ref();
    (child.stderr as unknown as { ref?: () => void } | null)?.ref?.();
  } else {
    child.unref();
    child.channel?.unref();
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  }
}

/** The parent's environment minus `NODE_OPTIONS`: a user flag there has crashed forked workers before. */
function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return env;
}

interface WorkingTreeGraphChildExit {
  budget: WorkingTreeGraphBuildBudget;
  reply: WorkingTreeGraphEntryReply | undefined;
  timedOut: boolean;
  processError: Error | undefined;
  stderrTail: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Order matters: our own kill wins (a reply racing the timer is discarded —
 * the budget is the contract); then a reply, which is the child's own account;
 * then the OOM signature; anything else is a death with its exit status.
 */
function classifyExit(exit: WorkingTreeGraphChildExit): WorkingTreeGraphBuildOutcome {
  if (exit.timedOut) return { kind: "timedOut", timeoutMs: exit.budget.timeoutMs };
  if (exit.reply?.kind === "built") return { kind: "built", graph: exit.reply.outcome };
  if (exit.reply?.kind === "failed") return { kind: "failed", reason: exit.reply.reason };
  if (exit.signal === "SIGABRT" || exit.code === SIGABRT_EXIT_CODE || HEAP_EXHAUSTED_PATTERN.test(exit.stderrTail)) {
    return { kind: "heapExhausted", heapLimitMb: exit.budget.heapLimitMb };
  }
  const status = exit.signal ? `signal ${exit.signal}` : `code ${String(exit.code)}`;
  const detail = exit.processError?.message ?? exit.stderrTail.trim().split("\n").slice(-3).join(" | ");
  return {
    kind: "failed",
    reason: `tree-graph child exited with ${status} and no reply${detail ? `: ${detail}` : ""}`,
  };
}
