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
import { PhaseProgressTracker } from "./phase-tracker.js";
import type { ProgressRenderer } from "./renderer.js";
import { formatIndexStatus } from "./status-format.js";

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
}

export async function superviseIndexing(child: WorkerHandle, opts: SuperviseOptions): Promise<number> {
  const { renderer, waitEnrichments, colors, out } = opts;
  const now = opts.now ?? (() => 0);
  const eta = new PhaseProgressTracker(now());
  let latestStatus: IndexStatus | undefined;

  return new Promise<number>((resolve) => {
    let settled = false;
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      renderer.stop();
      resolve(code);
    };

    const printStatus = (): void => {
      if (latestStatus) out(formatIndexStatus(latestStatus, colors));
    };

    const printEta = (): void => {
      const seconds = eta.aggregateEtaSeconds(now());
      if (seconds === null) {
        out(colors.dim("enrichments: running in background…"));
      } else {
        out(colors.dim(`enrichments: ~${Math.ceil(seconds)}s remaining (background)`));
      }
    };

    const printOutcome = (outcome: EnrichmentOutcome): void => {
      for (const p of outcome.failed) out(colors.alert(`✗ ${p}: enrichment failed`));
      for (const p of outcome.degraded) out(colors.warn(`⚠ ${p}: enrichment degraded`));
    };

    child.on("message", (raw) => {
      if (!isWorkerMessage(raw)) return;
      renderer.handle(raw);
      switch (raw.type) {
        case "embedding":
          // Already forwarded to the renderer above; no supervisor-side state.
          break;
        case "enrichment":
          eta.record(`${raw.providerKey}:${raw.level}`, raw.applied, raw.total, now());
          break;
        case "status":
          latestStatus = raw.status;
          if (!waitEnrichments) {
            // Index is searchable — print status + ETA, detach, return control.
            printStatus();
            printEta();
            child.disconnect?.();
            finish(0);
          }
          break;
        case "done":
          printStatus();
          printOutcome(raw.result);
          finish(raw.result.failed.length > 0 ? 1 : 0);
          break;
        case "error":
          out(colors.alert(`error: ${raw.message}`));
          finish(1);
          break;
      }
    });

    child.on("exit", (code) => {
      // Worker exited before a terminal message (crash) — surface a failure.
      finish(code === 0 ? 0 : 1);
    });
  });
}
