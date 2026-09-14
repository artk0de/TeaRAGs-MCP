/**
 * `stripChunkPartSuffix` — maps a chunker hard-cap part id back to its symbol
 * (bd tea-rags-mcp-fxio5).
 *
 * Live survey: every symbolId ending in `#part<digits>` (taxdome 6,637, max
 * index 27; tea-rags 4,253, max index 56) strips to the chunk's
 * parentSymbolId. Real methods whose NAME begins with "part" exist on both
 * indexes, so the strip needs the digits and the end anchor.
 */

import { describe, expect, it } from "vitest";

import { stripChunkPartSuffix } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/chunk-part-symbol.js";

describe("stripChunkPartSuffix", () => {
  it.each([
    ["X#participants", "X#participants"],
    ["X#partition_key_for", "X#partition_key_for"],
    ["X#partial_purchase", "X#partial_purchase"],
    ["X#m#part27", "X#m"],
    ["fn#part56", "fn"],
    ["X#part1", "X"],
  ])("%s -> %s", (input, expected) => {
    expect(stripChunkPartSuffix(input)).toBe(expected);
  });
});
