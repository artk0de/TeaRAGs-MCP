/**
 * Foreground supervisor for `index-codebase`.
 *
 * Consumes IPC progress messages from the detached worker child, drives the
 * progress renderer, and resolves an exit code per mode:
 * - default (no wait): on the first `status` message (index searchable after
 *   embeddings) print the status + a one-line enrichment ETA, detach the child
 *   (it finishes enrichment unattended) and resolve 0.
 * - `--wait-enrichments`: stay attached until the worker emits `done`, print the
 *   final status + outcome, and resolve non-zero if any provider failed.
 *
 * The child is injected (the command forks it) so this orchestration is unit
 * testable with a fake EventEmitter.
 */

import type { IndexStatus } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";
import { isWorkerMessage } from "./ipc-protocol.js";
import { OverallTimer, PhaseProgressTracker } from "./phase-tracker.js";
import { JsonProgressRenderer, type ProgressRenderer } from "./renderer.js";
import { IndexRunReportPrinter } from "./report-printer.js";

/** Minimal child handle — satisfied by Node `ChildProcess` and a test EventEmitter. */
export interface WorkerHandle {
  on: ((event: "message", listener: (msg: unknown) => void) => void) &
    ((event: "exit", listener: (code: number | null) => void) => void);
  /** IPC send — used to grant the worker "outlive" before a clean background
   *  detach so its parent-death guard does not kill it on disconnect. */
  send?: (msg: { type: string }) => void;
  disconnect?: () => void;
}

export interface SuperviseOptions {
  renderer: ProgressRenderer;
  waitEnrichments: boolean;
  colors: Colorizer;
  out: (line: string) => void;
  /** Injectable clock for the ETA tracker (ms). Defaults to a monotonic counter base. */
  now?: () => number;
  /** Registered project alias, threaded into the human and JSON status blocks. */
  projectName?: string;
  /** Resolved absolute path being indexed, threaded into the JSON status block. */
  path?: string;
}

export async function superviseIndexing(child: WorkerHandle, opts: SuperviseOptions): Promise<number> {
  const { renderer, waitEnrichments, colors, out } = opts;
  const now = opts.now ?? (() => 0);
  const eta = new PhaseProgressTracker(now());
  const overall = new OverallTimer(now());
  let latestStatus: IndexStatus | undefined;
  const jsonRenderer = renderer instanceof JsonProgressRenderer ? renderer : null;
  const printer = new IndexRunReportPrinter({
    out,
    colors,
    jsonRenderer,
    projectName: opts.projectName,
    path: opts.path,
  });
  const printStatus = (): void => {
    if (!latestStatus) return;
    printer.printStatus(latestStatus, overall.elapsedMs());
  };

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number, printAfterStop?: () => void): void => {
      if (settled) return;
      settled = true;
      overall.stop(now());
      renderer.stop();
      printAfterStop?.();
      printer.printTotal(overall.elapsedMs());
      resolve(code);
    };

    child.on("message", (raw) => {
      if (!isWorkerMessage(raw)) return;
      renderer.handle(raw);
      switch (raw.type) {
        case "phase-done":
          // Handled by renderer.handle (called above): TTY → multibar.log, line → sink, JSON → no-op.
          break;
        case "embedding":
          // Already forwarded to the renderer above; no supervisor-side state.
          break;
        case "turbo-migration":
          // Already forwarded to the renderer above; no supervisor-side state.
          break;
        case "enrichment":
          eta.record(`${raw.providerKey}:${raw.level}`, raw.applied, raw.total, now());
          break;
        case "status":
          latestStatus = raw.status;
          if (!waitEnrichments) {
            // Index is searchable — hand off cleanly: grant the worker "outlive"
            // so its parent-death guard keeps enriching in the background, THEN
            // detach. (An interrupt/kill skips this message → the worker's guard
            // reaps its git children instead of orphaning them.)
            child.send?.({ type: "outlive" });
            // Stop bars first, then print status + ETA.
            child.disconnect?.();
            finish(0, () => {
              printStatus();
              printer.printEta(eta.aggregateEtaSeconds(now()));
            });
          }
          break;
        case "done":
          finish(raw.result.failed.length > 0 ? 1 : 0, () => {
            printStatus();
            printer.printOutcome(raw.result);
          });
          break;
        case "qdrant-state":
          // Rendered by renderer.handle (called above): the daemon state line
          // shows BEFORE any progress bars while the worker waits (2nfdm).
          break;
        case "embedding-state":
          // Rendered by renderer.handle (called above): the embedding
          // provider's recovery wait, shown like the qdrant one (umatc).
          break;
        case "error":
          finish(1, () => {
            printer.printError(raw);
          });
          break;
      }
    });

    child.on("exit", (code) => {
      // Worker exited before a terminal message (crash). Surface it in BOTH
      // modes — a bare non-zero exit code with no output is undebuggable.
      if (code === 0) {
        finish(0);
        return;
      }
      finish(1, () => {
        printer.printWorkerExit(code);
      });
    });
  });
}
