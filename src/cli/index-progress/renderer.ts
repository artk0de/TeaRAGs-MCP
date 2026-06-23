/**
 * Progress rendering for `index-codebase`.
 *
 * Two implementations behind one {@link ProgressRenderer} interface:
 * - {@link TtyProgressRenderer} drives a `cli-progress` multibar (one primary
 *   embedding bar + one bar per enrichment provider/level), for interactive TTYs.
 * - {@link LineProgressRenderer} writes de-duplicated plain lines through an
 *   injected sink, for non-TTY / piped / CI output.
 *
 * `formatProgressLine` is the pure event→string core shared by the line renderer
 * and unit tests.
 */

import cliProgress from "cli-progress";

import type { IndexStatus } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";
import type { EnrichmentOutcome, WorkerMessage } from "./ipc-protocol.js";
import { computeEtaSeconds } from "./phase-tracker.js";

export interface ProgressRenderer {
  handle: (message: WorkerMessage) => void;
  stop: () => void;
}

/** Fixed label column width for aligned output (label padded to this width). */
const LABEL_WIDTH = 22;

/**
 * Format an ETA (seconds, or null when not yet computable) for a progress bar.
 * Returns empty string when unknown or complete (value ≤ 0 or null).
 */
export function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "";
  if (seconds < 60) return `~${Math.ceil(seconds)}s`;
  return `~${(seconds / 60).toFixed(1)}m`;
}

/** Pure: render a progress message as one log line, or null when it is not a progress line. */
export function formatProgressLine(message: WorkerMessage): string | null {
  switch (message.type) {
    case "embedding": {
      const label = "embedding".padEnd(LABEL_WIDTH);
      const pct = message.total > 0 ? Math.round((message.current / message.total) * 100) : 0;
      const base = `${label}${message.current}/${message.total} (${pct}%)`;
      return message.throughput !== null && message.throughput !== undefined
        ? `${base} (${message.throughput.toFixed(1)} ch/s)`
        : base;
    }
    case "enrichment": {
      const rawLabel = `${message.providerKey} ${message.level}`;
      const label = rawLabel.padEnd(LABEL_WIDTH);
      const pct = message.total > 0 ? Math.round((message.applied / message.total) * 100) : 0;
      return `${label}${message.applied}/${message.total} (${pct}%)`;
    }
    case "error":
      return `error: ${message.message}`;
    case "status":
    case "done":
    case "phase-done":
      return null;
  }
}

/** Non-TTY renderer: emits de-duplicated lines via the injected sink. */
export class LineProgressRenderer implements ProgressRenderer {
  private lastLine: string | null = null;

  constructor(private readonly sink: (line: string) => void) {}

  handle(message: WorkerMessage): void {
    const line = formatProgressLine(message);
    if (line === null || line === this.lastLine) return;
    this.lastLine = line;
    this.sink(line);
  }

  stop(): void {
    // no persistent handle to release
  }
}

/** TTY renderer: a cli-progress multibar with an embedding bar + per-provider bars. */
export class TtyProgressRenderer implements ProgressRenderer {
  private readonly multibar: cliProgress.MultiBar;
  private embeddingBar: cliProgress.SingleBar | null = null;
  private readonly enrichmentBars = new Map<string, cliProgress.SingleBar>();
  /** Per-bar start timestamp keyed by bar key ("embedding" or "providerKey:level"). */
  private readonly barStartMs = new Map<string, number>();

  constructor(
    private readonly colors: Colorizer,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: " {label} {bar} {value}/{total} ({percentage}%) {eta} {rate}",
        stream: process.stderr,
      },
      cliProgress.Presets.shades_classic,
    );
  }

  handle(message: WorkerMessage): void {
    if (message.type === "embedding") {
      const label = this.colors.brand("embeddings".padEnd(LABEL_WIDTH));
      const rate =
        message.throughput !== null && message.throughput !== undefined ? `${message.throughput.toFixed(1)} ch/s` : "";
      if (!this.embeddingBar) {
        this.barStartMs.set("embedding", this.now());
        this.embeddingBar = this.multibar.create(message.total, 0, { label, rate, eta: "" });
      }
      const startMs = this.barStartMs.get("embedding") ?? this.now();
      const eta = formatEta(computeEtaSeconds(message.current, message.total, this.now() - startMs));
      this.embeddingBar.update(message.current, { label, rate, eta });
      this.embeddingBar.setTotal(message.total);
      return;
    }
    if (message.type === "enrichment") {
      const key = `${message.providerKey}:${message.level}`;
      const rawLabel = `${message.providerKey} ${message.level}`;
      const label = this.colors.brand(rawLabel.padEnd(LABEL_WIDTH));
      let bar = this.enrichmentBars.get(key);
      if (!bar) {
        this.barStartMs.set(key, this.now());
        bar = this.multibar.create(message.total, 0, { label, rate: "", eta: "" });
        this.enrichmentBars.set(key, bar);
      }
      const startMs = this.barStartMs.get(key) ?? this.now();
      const eta = formatEta(computeEtaSeconds(message.applied, message.total, this.now() - startMs));
      bar.setTotal(message.total);
      bar.update(message.applied, { label, rate: "", eta });
    }
  }

  stop(): void {
    this.multibar.stop();
  }
}

/**
 * JSON-mode renderer: bars are no-ops. Records the latest status, phase-done
 * timings, done outcome, and error so the supervisor can emit one JSON object
 * at finish. Forces NO_COLOR semantics — callers should pass a plain colorizer.
 */
export class JsonProgressRenderer implements ProgressRenderer {
  private _latestStatus: IndexStatus | undefined;
  private _phases: Record<string, number> = {};
  private _outcome: EnrichmentOutcome | undefined;
  private _error: string | undefined;

  handle(message: WorkerMessage): void {
    switch (message.type) {
      case "status":
        this._latestStatus = message.status;
        break;
      case "phase-done":
        this._phases[message.phase] = message.elapsedMs;
        break;
      case "done":
        this._outcome = message.result;
        break;
      case "error":
        this._error = message.message;
        break;
      case "embedding":
      case "enrichment":
        // no-op in JSON mode — progress bars suppressed
        break;
    }
  }

  stop(): void {
    // no persistent handle to release
  }

  get latestStatus(): IndexStatus | undefined {
    return this._latestStatus;
  }

  get phases(): Record<string, number> {
    return this._phases;
  }

  get outcome(): EnrichmentOutcome | undefined {
    return this._outcome;
  }

  get error(): string | undefined {
    return this._error;
  }
}

export interface RendererOptions {
  isTTY: boolean;
  colors: Colorizer;
  /** Set true to suppress all human-readable output and collect JSON state. */
  json?: boolean;
  /** Sink for the non-TTY line renderer. Defaults to stderr. */
  sink?: (line: string) => void;
}

export function createRenderer(opts: RendererOptions): ProgressRenderer {
  if (opts.json) return new JsonProgressRenderer();
  if (opts.isTTY) return new TtyProgressRenderer(opts.colors);
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  return new LineProgressRenderer(sink);
}
