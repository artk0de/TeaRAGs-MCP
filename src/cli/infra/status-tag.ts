/**
 * Bracketed status tags (`[OK]`, `[WARN]`, `[FAIL]` …) for line-oriented CLI
 * reports such as `tea-rags doctor`.
 *
 * Every tag occupies the same fixed width so the text after it lines up. The
 * padding sits OUTSIDE the color escape, so the visible layout is identical
 * with or without ANSI — tests assert on plain text with color forced off.
 */

import type { Colorizer } from "./color.js";

export type StatusLevel = "ok" | "warn" | "fail" | "kill" | "dry";

const LABEL: Record<StatusLevel, string> = {
  ok: "[OK]",
  warn: "[WARN]",
  fail: "[FAIL]",
  kill: "[KILL]",
  dry: "[DRY]",
};

const TAG_WIDTH = 6;

function paint(level: StatusLevel, c: Colorizer): (s: string) => string {
  switch (level) {
    case "ok":
      return c.ok;
    case "warn":
    case "kill":
      return c.warn;
    case "fail":
      return c.alert;
    case "dry":
      return c.dim;
  }
}

/** A fixed-width, role-colored status tag; callers add their own separator. */
export function statusTag(level: StatusLevel, c: Colorizer): string {
  const label = LABEL[level];
  return paint(level, c)(label) + " ".repeat(TAG_WIDTH - label.length);
}
