/** Value formatting shared by the per-family report mappers and the report's shaping seams. */

import type { CompositionTableCutSummary } from "../../../public/dto/architecture.js";

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Locale-independent, so the order is the same on every machine. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The composition-table cut on the report's 3-decimal scale (bd tea-rags-mcp-r8hme.52.17). */
export function roundCompositionTableCut(cut: CompositionTableCutSummary): CompositionTableCutSummary {
  return {
    thresholdMethod: cut.thresholdMethod,
    ...(cut.q === undefined ? {} : { q: cut.q }),
    ...(cut.nullMean === undefined ? {} : { nullMean: round3(cut.nullMean) }),
    median: cut.median,
    population: cut.population,
    ...(cut.testedCount === undefined ? {} : { testedCount: cut.testedCount }),
    fileCount: cut.fileCount,
  };
}
