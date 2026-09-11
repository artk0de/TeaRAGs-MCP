import { describe, expect, it } from "vitest";

import { cosine } from "../../../src/core/infra/vector-math.js";

describe("cosine", () => {
  it("scores identical direction as 1 regardless of magnitude", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBe(1);
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  });

  it("scores orthogonal vectors as 0 and opposite ones as -1", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [-1, 0])).toBe(-1);
  });

  it("returns 0 when either vector has no magnitude", () => {
    // The zero vector has no direction; a division would be NaN, and callers
    // read the result as a similarity they can compare against a threshold.
    expect(cosine([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosine([1, 2, 3], [0, 0, 0])).toBe(0);
  });
});
