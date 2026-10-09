/**
 * Seeded randomness — foundation statistics (bd tea-rags-mcp-dm61n): the
 * co-change burst-window baseline sample and the shotgun-surgery echo
 * permutation test draw from the same PRNG, seeded from data, never from the
 * clock or evaluation order.
 */
import { describe, expect, it } from "vitest";

import { mulberry32, seedFromKey } from "../../../../src/core/infra/statistics/index.js";

describe("mulberry32", () => {
  it("keeps the sequence it produced before the lift into infra", () => {
    const random = mulberry32(1);
    expect([random(), random(), random(), random(), random()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741, 0.9683778982143849,
    ]);
  });
});

describe("seedFromKey", () => {
  it("is FNV-1a 32-bit over the key's UTF-16 code units", () => {
    expect(seedFromKey("")).toBe(0x811c9dc5);
    expect(seedFromKey("a")).toBe(0xe40c292c);
    expect(seedFromKey("foobar")).toBe(0xbf9cf968);
  });
});
