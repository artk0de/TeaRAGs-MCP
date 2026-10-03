/**
 * Spawner of the working-tree graph build (epic xi2r9, WTO-7): forks the
 * compiled `tree-graph-entry.js` under a heap ceiling and a time budget, and
 * turns however the child ended into a `WorkingTreeGraphBuildOutcome`.
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

/** How much the child may spend before it is killed. */
export interface WorkingTreeGraphBuildBudget {
  /** Wall-clock budget from fork to exit; SIGKILL past it. */
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

/** Bytes of the child's stderr kept for a `failed` reason and the OOM check. */
const STDERR_TAIL_BYTES = 8192;

/** V8's fatal-OOM banner — what a heap exhaustion prints before it aborts. */
const HEAP_EXHAUSTED_PATTERN = /heap out of memory|Reached heap limit/i;

/** Exit code of a process killed by SIGABRT, which V8 raises on a fatal OOM. */
const SIGABRT_EXIT_CODE = 134;

export class WorkingTreeGraphProcessBuilder {
  /** Children forked and not yet closed — what {@link killInFlight} reaps. */
  private readonly running = new Set<ChildProcess>();

  /** @param entryPath The compiled child entry; tests may point it elsewhere. */
  constructor(private readonly entryPath: string = TREE_GRAPH_ENTRY_PATH) {}

  /**
   * SIGKILL every child still running, synchronously — for a process that is
   * exiting (bd tea-rags-mcp-xi2r9, D6): an abandoned build would otherwise
   * finish into a staging dir nobody publishes. Each killed build settles as
   * `failed` on its child's `close`, like any death without a reply.
   */
  killInFlight(): void {
    for (const child of this.running) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  /**
   * Fork one tree build and wait for the child to exit. The promise settles on
   * the child's `close` — after its exit AND its stderr drained — so a settled
   * outcome never leaves a process behind, a killed one included.
   */
  async build(
    input: WorkingTreeGraphBuildInput,
    budget: WorkingTreeGraphBuildBudget,
  ): Promise<WorkingTreeGraphBuildOutcome> {
    if (!(budget.timeoutMs > 0) || !(budget.heapLimitMb > 0)) {
      throw new Error(`WorkingTreeGraphProcessBuilder: budget must be positive (got ${JSON.stringify(budget)})`);
    }
    const request: WorkingTreeGraphEntryRequest = { input, debug: isDebug() };
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = fork(this.entryPath, [], {
          // Replaces (not extends) the parent's execArgv: vitest's or a dev
          // loader's flags have no business in a plain-JS child.
          execArgv: [`--max-old-space-size=${Math.floor(budget.heapLimitMb)}`],
          env: childEnvironment(),
          // stdout is ignored, never inherited: the MCP server's stdout is the
          // protocol channel.
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
      } catch (err) {
        resolve({ kind: "failed", reason: `tree-graph fork failed: ${(err as Error).message}` });
        return;
      }
      this.running.add(child);

      let reply: WorkingTreeGraphEntryReply | undefined;
      let timedOut = false;
      let processError: Error | undefined;
      let stderrTail = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        // The parent's stderr is the MCP server's log — the child's lines reach
        // it only under DEBUG, like every other codegraph diagnostic.
        if (isDebug()) process.stderr.write(chunk);
        stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
      });
      child.on("message", (message: unknown) => {
        if (isWorkingTreeGraphEntryReply(message)) reply = message;
      });
      child.on("error", (err) => {
        processError = err;
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, budget.timeoutMs);
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        this.running.delete(child);
        resolve(classifyExit({ budget, reply, timedOut, processError, stderrTail, code, signal }));
      });
      child.send(request, (err) => {
        if (err) processError ??= err;
      });
    });
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
