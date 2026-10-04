/**
 * One member of an example pack, read back out of it (bd tea-rags-mcp-g5i0a).
 */

import { describe, expect, it } from "vitest";

import { examplePackMember } from "../../../../src/core/domains/explore/test-pack.js";

const SCOPE = "Cart.describe 'Cart'";
const FIRST = `${SCOPE}.it 'adds'`;
const SECOND = `${SCOPE}.it 'adds'~2`;

const pack: Record<string, unknown> = {
  symbolId: FIRST,
  name: "it 'adds'",
  parentSymbolId: SCOPE,
  parentType: "test_scope",
  chunkType: "test",
  relativePath: "tests/cart.test.ts",
  startLine: 2,
  endLine: 9,
  content: [
    "describe('Cart', () => {",
    "it('adds', () => {",
    "  add(1);",
    "});",
    "it('adds', () => {",
    "  add(2);",
    "  add(3);",
    "});",
  ].join("\n"),
  memberSymbolIds: [FIRST, SECOND],
  memberLineRanges: [
    { start: 2, end: 4 },
    { start: 6, end: 9 },
  ],
  memberRowCounts: [3, 4],
};

describe("examplePackMember", () => {
  it("returns the member's own rows under the pack header, its id, name without ~N, and own lines", () => {
    expect(examplePackMember(pack, SECOND)).toEqual({
      symbolId: SECOND,
      name: "it 'adds'",
      parentSymbolId: SCOPE,
      parentType: "test_scope",
      chunkType: "test",
      relativePath: "tests/cart.test.ts",
      startLine: 6,
      endLine: 9,
      content: ["describe('Cart', () => {", "it('adds', () => {", "  add(2);", "  add(3);", "});"].join("\n"),
    });
  });

  it("answers a metaOnly payload (no content) with the member's id and lines", () => {
    const { content: _content, ...meta } = pack;
    expect(examplePackMember(meta, FIRST)).toMatchObject({ symbolId: FIRST, startLine: 2, endLine: 4 });
  });

  it.each([
    ["the id is not a member", pack, `${SCOPE}.it 'removes'`],
    ["the chunk is a setup pack, not an example pack", { ...pack, parentType: "describe" }, FIRST],
    ["the pack carries no row counts (an older index)", { ...pack, memberRowCounts: undefined }, SECOND],
    ["the row counts are misaligned", { ...pack, memberRowCounts: [3] }, SECOND],
    ["a row count is not positive", { ...pack, memberRowCounts: [3, 0] }, SECOND],
    ["the pack carries no member line ranges", { ...pack, memberLineRanges: undefined }, SECOND],
    ["a member line range is malformed", { ...pack, memberLineRanges: [{ start: 2, end: 4 }, { start: 6 }] }, SECOND],
    ["the rows do not add up", { ...pack, memberRowCounts: [3, 40] }, SECOND],
    ["the chunk carries no member ids", { ...pack, memberSymbolIds: undefined }, FIRST],
  ])("keeps the whole chunk when %s", (_why, payload, id) => {
    expect(examplePackMember(payload, id)).toBeUndefined();
  });
});
