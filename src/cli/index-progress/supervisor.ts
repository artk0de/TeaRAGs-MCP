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
import { isWorkerMessage, type EnrichmentOutcome } from "./ipc-protocol.js";
import { OverallTimer, PhaseProgressTracker } from "./phase-tracker.js";
import { JsonProgressRenderer, type ProgressRenderer } from "./renderer.js";
import { formatIndexStatus, formatIndexStatusJson } from "./status-format.js";

/** Format a duration in ms: sub-second → "Nms", otherwise "N.Ns". */
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Minimal child handle — satisfied by Node `ChildProcess` and a test EventEmitter. */
export interface WorkerHandle {
  on: ((event: "message", listener: (msg: unknown) => void) => void) &
    ((event: "exit", listener: (code: number | null) => void) => void);
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

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number, printAfterStop?: () => void): void => {
      if (settled) return;
      settled = true;
      overall.stop(now());
      renderer.stop();
      printAfterStop?.();
      if (!jsonRenderer) {
        out(colors.bold(`total ${fmtDuration(overall.elapsedMs())}`));
      }
      resolve(code);
    };

    const printStatus = (): void => {
      if (!latestStatus) return;
      if (jsonRenderer) {
        const o = formatIndexStatusJson(latestStatus, {
          projectName: opts.projectName,
          path: opts.path ?? "",
          phases: jsonRenderer.phases,
          overallMs: overall.elapsedMs(),
          outcome: jsonRenderer.outcome,
        });
        out(JSON.stringify(o, null, 2));
      } else {
        out(formatIndexStatus(latestStatus, colors, { projectName: opts.projectName, path: opts.path }));
      }
    };

    const printEta = (): void => {
      if (jsonRenderer) return;
      const seconds = eta.aggregateEtaSeconds(now());
      if (seconds === null) {
        out(colors.dim("enrichments: running in background…"));
      } else {
        out(colors.dim(`enrichments: ~${Math.ceil(seconds)}s remaining (background)`));
      }
    };

    const printOutcome = (outcome: EnrichmentOutcome): void => {
      if (jsonRenderer) return;
      for (const p of outcome.failed) out(colors.alert(`✗ ${p}: enrichment failed`));
      for (const p of outcome.degraded) out(colors.warn(`⚠ ${p}: enrichment degraded`));
    };

    child.on("message", (raw) => {
      if (!isWorkerMessage(raw)) return;
      renderer.handle(raw);
      switch (raw.type) {
        case "phase-done":
          if (!jsonRenderer) out(colors.dim(`${raw.phase} done in ${fmtDuration(raw.elapsedMs)}`));
          break;
        case "embedding":
          // Already forwarded to the renderer above; no supervisor-side state.
          break;
        case "enrichment":
          eta.record(`${raw.providerKey}:${raw.level}`, raw.applied, raw.total, now());
          break;
        case "status":
          latestStatus = raw.status;
          if (!waitEnrichments) {
            // Index is searchable — stop bars first, then print status + ETA.
            child.disconnect?.();
            finish(0, () => {
              printStatus();
              if (!jsonRenderer) printEta();
            });
          }
          break;
        case "done":
          finish(raw.result.failed.length > 0 ? 1 : 0, () => {
            printStatus();
            printOutcome(raw.result);
          });
          break;
        case "error":
          finish(1, () => {
            if (!jsonRenderer) out(colors.alert(`error: ${raw.message}`));
          });
          break;
      }
    });

    child.on("exit", (code) => {
      // Worker exited before a terminal message (crash) — surface a failure.
      finish(code === 0 ? 0 : 1);
    });
  });
}
