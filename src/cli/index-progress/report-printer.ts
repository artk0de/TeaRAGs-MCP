/**
 * Renders an `index-codebase` run's final report — status block, enrichment
 * ETA, enrichment outcome, fatal error, worker-crash line and the total
 * duration — in either human or `--json` mode.
 *
 * The supervisor decides WHEN each piece is printed (its exit-code and detach
 * state machine); this class owns HOW it looks, including which pieces a mode
 * suppresses (JSON mode emits one status object or one error object and
 * nothing else).
 */

import type { IndexStatus } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";
import type { EnrichmentOutcome, WorkerMessage } from "./ipc-protocol.js";
import { fmtDuration } from "./phase-tracker.js";
import type { JsonProgressRenderer } from "./renderer.js";
import { formatIndexStatus, formatIndexStatusJson } from "./status-format.js";

export interface IndexRunReportPrinterOptions {
  out: (line: string) => void;
  colors: Colorizer;
  /** Non-null selects `--json` mode; it supplies the phase timings and outcome the status object embeds. */
  jsonRenderer: JsonProgressRenderer | null;
  /** Registered project alias, threaded into the human and JSON status blocks. */
  projectName?: string;
  /** Resolved absolute path being indexed, threaded into the JSON status block. */
  path?: string;
}

export class IndexRunReportPrinter {
  constructor(private readonly opts: IndexRunReportPrinterOptions) {}

  printStatus(status: IndexStatus, overallMs: number): void {
    const { out, colors, jsonRenderer } = this.opts;
    if (jsonRenderer) {
      const o = formatIndexStatusJson(status, {
        projectName: this.opts.projectName,
        path: this.opts.path ?? "",
        phases: jsonRenderer.phases,
        overallMs,
        outcome: jsonRenderer.outcome,
      });
      out(JSON.stringify(o, null, 2));
    } else {
      out(formatIndexStatus(status, colors, { projectName: this.opts.projectName, path: this.opts.path }));
    }
  }

  /** `seconds` is the aggregate enrichment ETA, or null when it cannot be estimated yet. */
  printEta(seconds: number | null): void {
    const { out, colors, jsonRenderer } = this.opts;
    if (jsonRenderer) return;
    if (seconds === null) {
      out(colors.dim("enrichments: running in background…"));
    } else {
      out(colors.dim(`enrichments: ~${Math.ceil(seconds)}s remaining (background)`));
    }
  }

  printOutcome(outcome: EnrichmentOutcome): void {
    const { out, colors, jsonRenderer } = this.opts;
    if (jsonRenderer) return;
    for (const p of outcome.failed) out(colors.alert(`✗ ${p}: enrichment failed`));
    for (const p of outcome.degraded) out(colors.warn(`⚠ ${p}: enrichment degraded`));
  }

  printError(raw: Extract<WorkerMessage, { type: "error" }>): void {
    const { out, colors, jsonRenderer } = this.opts;
    // Run-phase fatal. JSON mode must emit a parseable error object —
    // a silent exit 1 with zero bytes is exactly the 2nfdm bug.
    // The hint is the actionable half of a typed fatal ("Start Ollama:
    // …"), so it is printed wherever the message is (bd tea-rags-mcp-umatc).
    if (jsonRenderer) {
      out(
        JSON.stringify({
          error: {
            code: raw.code ?? "UNKNOWN",
            message: raw.message,
            ...(raw.hint !== undefined ? { hint: raw.hint } : {}),
          },
        }),
      );
    } else {
      out(colors.alert(`error: ${raw.message}`));
      if (raw.hint !== undefined) out(`hint: ${raw.hint}`);
    }
  }

  /** Worker exited before a terminal message (crash). Surfaced in BOTH modes — a bare non-zero exit code with no output is undebuggable. */
  printWorkerExit(code: number | null): void {
    const { out, colors, jsonRenderer } = this.opts;
    const message = `worker exited with code ${code ?? "null"} before reporting a result`;
    if (jsonRenderer) out(JSON.stringify({ error: { code: "WORKER_EXIT", message } }));
    else out(colors.alert(message));
  }

  printTotal(elapsedMs: number): void {
    const { out, colors, jsonRenderer } = this.opts;
    if (!jsonRenderer) {
      out(colors.bold(`total ${fmtDuration(elapsedMs)}`));
    }
  }
}
