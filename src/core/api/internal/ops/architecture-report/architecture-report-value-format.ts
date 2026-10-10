/** Value formatting shared by the per-family report mappers and the report's shaping seams. */

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Locale-independent, so the order is the same on every machine. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
