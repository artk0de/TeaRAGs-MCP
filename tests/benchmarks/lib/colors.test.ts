/**
 * The tune benchmark's terminal renderer. `bar` and `formatRate` are the only
 * verdict an operator gets while a long tuning run is in flight — the bar says
 * how close the current measurement is to the best one seen, the colour tier
 * says whether that is good enough to keep. Both thresholds and the
 * optional-subtitle handling of the frame printers are pinned here.
 */

import { describe, expect, it, vi } from "vitest";

// @ts-expect-error - benchmarks/ is plain JS outside the TS program, so it ships no declarations
import { bar, c, formatRate, printBox, printHeader } from "../../../benchmarks/lib/colors.mjs";

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

function strip(value: string): string {
  return value.replace(ANSI, "");
}

/** Collects what a printer wrote, with colour codes removed. */
function captureLog(run: () => void): string[] {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    run();
    return spy.mock.calls.map((args) => strip(args.map(String).join(" ")));
  } finally {
    spy.mockRestore();
  }
}

describe("bar", () => {
  it("fills in proportion to the best measurement and clamps at full width", () => {
    expect(strip(bar(5, 10, 10))).toBe("█████░░░░░");
    expect(strip(bar(0, 10, 10))).toBe("░░░░░░░░░░");
    expect(strip(bar(10, 10, 10))).toBe("██████████");
    // A measurement above the incumbent best must not overflow the bar.
    expect(strip(bar(50, 10, 10))).toBe("██████████");
  });

  it("defaults to a 20-cell bar so successive rows stay column-aligned", () => {
    expect(strip(bar(3, 10))).toHaveLength(20);
    expect(strip(bar(9, 10))).toHaveLength(20);
  });

  it("colours by how close the run is to the best: green ≥95%, yellow ≥80%, gray below", () => {
    expect(bar(10, 10, 10)).toContain(c.green);
    expect(bar(9.5, 10, 10)).toContain(c.green);
    expect(bar(9, 10, 10)).toContain(c.yellow);
    expect(bar(8, 10, 10)).toContain(c.yellow);
    expect(bar(7.9, 10, 10)).toContain(c.gray);
  });
});

describe("formatRate", () => {
  it("renders the measured value with its unit", () => {
    expect(strip(formatRate(1200, "chunks/s"))).toBe("1200 chunks/s");
  });

  it("flags throughput tiers: green ≥1000, yellow ≥500, gray below", () => {
    expect(formatRate(1000, "chunks/s")).toContain(c.green);
    expect(formatRate(999, "chunks/s")).toContain(c.yellow);
    expect(formatRate(500, "chunks/s")).toContain(c.yellow);
    expect(formatRate(499, "chunks/s")).toContain(c.gray);
  });
});

describe("printHeader", () => {
  it("frames the title between rules and prints the subtitle only when supplied", () => {
    const withSubtitle = captureLog(() => {
      printHeader("Embedding calibration", "quick mode");
    });
    const withoutSubtitle = captureLog(() => {
      printHeader("Embedding calibration");
    });

    expect(withSubtitle).toContain("Embedding calibration");
    expect(withSubtitle).toContain("quick mode");
    expect(withoutSubtitle).toContain("Embedding calibration");
    expect(withoutSubtitle.join("\n")).not.toContain("quick mode");
    expect(withoutSubtitle).toHaveLength(withSubtitle.length - 1);
  });
});

describe("printBox", () => {
  it("pads every framed line to one width so the box does not shear", () => {
    const lines = captureLog(() => {
      printBox("Tuning complete", "42s elapsed");
    });
    const framed = lines.filter((line) => line.startsWith("║"));

    expect(framed).toHaveLength(2);
    expect(framed[0]).toContain("Tuning complete");
    expect(framed[1]).toContain("42s elapsed");
    expect(new Set(framed.map((line) => line.length)).size).toBe(1);
  });

  it("drops the subtitle row entirely when there is no subtitle", () => {
    const lines = captureLog(() => {
      printBox("Tuning complete");
    });

    expect(lines.filter((line) => line.startsWith("║"))).toHaveLength(1);
  });
});
