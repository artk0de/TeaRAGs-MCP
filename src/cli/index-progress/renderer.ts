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

import type { Colorizer } from "../infra/color.js";
import type { WorkerMessage } from "./ipc-protocol.js";

export interface ProgressRenderer {
  handle: (message: WorkerMessage) => void;
  stop: () => void;
}

/** Fixed label column width for aligned output (label padded to this width). */
const LABEL_WIDTH = 22;

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

  constructor(private readonly colors: Colorizer) {
    this.multibar = new cliProgress.MultiBar(
      {
        clearOnComplete: false,
        hideCursor: true,
        format: " {label} {bar} {value}/{total} ({percentage}%) {eta_formatted} {rate}",
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
        this.embeddingBar = this.multibar.create(message.total, 0, { label, rate });
      }
      this.embeddingBar.update(message.current, { label, rate });
      this.embeddingBar.setTotal(message.total);
      return;
    }
    if (message.type === "enrichment") {
      const key = `${message.providerKey}:${message.level}`;
      const rawLabel = `${message.providerKey} ${message.level}`;
      const label = this.colors.brand(rawLabel.padEnd(LABEL_WIDTH));
      let bar = this.enrichmentBars.get(key);
      if (!bar) {
        bar = this.multibar.create(message.total, 0, { label, rate: "" });
        this.enrichmentBars.set(key, bar);
      }
      bar.setTotal(message.total);
      bar.update(message.applied, { label, rate: "" });
    }
  }

  stop(): void {
    this.multibar.stop();
  }
}

export interface RendererOptions {
  isTTY: boolean;
  colors: Colorizer;
  /** Sink for the non-TTY line renderer. Defaults to stderr. */
  sink?: (line: string) => void;
}

export function createRenderer(opts: RendererOptions): ProgressRenderer {
  if (opts.isTTY) return new TtyProgressRenderer(opts.colors);
  const sink = opts.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  return new LineProgressRenderer(sink);
}
