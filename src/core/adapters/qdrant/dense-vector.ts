/**
 * The dense vector of a stored point, whatever shape the collection stores it
 * in: a bare array for a single-vector collection, `{ dense, sparse }` once
 * hybrid is enabled. Undefined when the point carries no dense vector.
 */
export function denseVectorOf(vector: unknown): number[] | undefined {
  if (Array.isArray(vector) && typeof vector[0] === "number") return vector as number[];
  if (vector && typeof vector === "object") {
    for (const value of Object.values(vector as Record<string, unknown>)) {
      if (Array.isArray(value) && typeof value[0] === "number") return value as number[];
    }
  }
  return undefined;
}
