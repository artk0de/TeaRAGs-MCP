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
 *
 * `buildBarLine` is the pure bar-assembly helper used by the TTY format function
 * and unit tests.
 */

import cliProgress from "cli-progress";

import type { IndexStatus } from "../../core/api/public/index.js";
import type { Colorizer } from "../infra/color.js";
import type { EnrichmentOutcome, WorkerMessage } from "./ipc-protocol.js";
import { computeEtaSeconds, fmtDuration } from "./phase-tracker.js";

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

export interface BuildBarLineParams {
  label: string;
  /** Fraction 0..1. */
  progress: number;
  /** Raw value (may exceed total; will be clamped to total before display). */
  value: number;
  total: number;
  elapsed: string;
  eta: string;
  rate: string;
  barsize: number;
  colors: Colorizer;
}

/**
 * Pure function: assembles one progress bar line.
 * Bar glyphs use `colors.brand` (filled) and `colors.dim` (incomplete).
 * When colors are disabled both are identity, producing plain glyphs.
 * Value is clamped to total so displayed fraction never exceeds 100%.
 */
export function buildBarLine(params: BuildBarLineParams): string {
  const { label, progress, value, total, elapsed, eta, rate, barsize, colors } = params;
  const filled = Math.round((progress ?? 0) * barsize);
  const empty = Math.max(0, barsize - filled);
  const bar = colors.brand("█".repeat(filled)) + colors.dim("░".repeat(empty));
  const clampedValue = Math.min(value, total);
  const pct = `${Math.round((progress ?? 0) * 100)}%`;
  const parts = [` ${label}`, bar, `${clampedValue}/${total}`, `(${pct})`, elapsed, eta, rate].filter(
    (p) => p.trim() !== "",
  );
  return parts.join(" ");
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
    case "phase-done":
      return `${message.phase} done in ${fmtDuration(message.elapsedMs)}`;
    case "error":
      return `error: ${message.message}`;
    case "status":
    case "done":
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
  private embeddingTotal = 0;
  private readonly enrichmentBars = new Map<string, cliProgress.SingleBar>();
  private readonly enrichmentTotals = new Map<string, number>();
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
        format: (options: cliProgress.Options, params: cliProgress.Params, payload: Record<string, string>): string => {
          const size = options.barsize ?? 40;
          return buildBarLine({
            label: payload["label"] ?? "",
            progress: params.progress ?? 0,
            value: params.value,
            total: params.total,
            elapsed: payload["elapsed"] ?? "",
            eta: payload["eta"] ?? "",
            rate: payload["rate"] ?? "",
            barsize: size,
            colors: this.colors,
          });
        },
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
        this.embeddingTotal = message.total;
        this.embeddingBar = this.multibar.create(message.total, 0, { label, rate, eta: "", elapsed: "" });
      }
      this.embeddingTotal = message.total;
      const startMs = this.barStartMs.get("embedding") ?? this.now();
      const elapsed = fmtDuration(this.now() - startMs);
      const eta = formatEta(computeEtaSeconds(message.current, message.total, this.now() - startMs));
      const clamped = Math.min(message.current, message.total);
      this.embeddingBar.update(clamped, { label, rate, eta, elapsed });
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
        this.enrichmentTotals.set(key, message.total);
        bar = this.multibar.create(message.total, 0, { label, rate: "", eta: "", elapsed: "" });
        this.enrichmentBars.set(key, bar);
      }
      this.enrichmentTotals.set(key, message.total);
      const startMs = this.barStartMs.get(key) ?? this.now();
      const elapsed = fmtDuration(this.now() - startMs);
      const eta = formatEta(computeEtaSeconds(message.applied, message.total, this.now() - startMs));
      const clamped = Math.min(message.applied, message.total);
      bar.setTotal(message.total);
      bar.update(clamped, { label, rate: "", eta, elapsed });
      return;
    }
    if (message.type === "phase-done") {
      // Complete that phase's bars to 100% — the phase IS done; small gap is quarantined chunks.
      if (message.phase === "embedding" && this.embeddingBar) {
        this.embeddingBar.update(this.embeddingTotal);
      } else if (message.phase === "enrichment") {
        for (const [key, bar] of this.enrichmentBars) {
          bar.update(this.enrichmentTotals.get(key) ?? 0);
        }
      }
      // Print above the live bars — no stdout collision.
      const line = this.colors.dim(`${message.phase} done in ${fmtDuration(message.elapsedMs)}`);
      (this.multibar as unknown as { log: (s: string) => void }).log(`${line}\n`);
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
