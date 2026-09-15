/**
 * Which requested chunks a caller may bare-stamp when a provider's overlay map
 * omits them (bd tea-rags-mcp-39xca.2).
 *
 * Git omits a chunk with no commits and relies on the caller to stamp it, or it
 * stays a recovery candidate forever. Codegraph settles chunks explicitly — an
 * empty overlay is its "settled without signal values" — so a chunk it omits is
 * one it could not settle, and stamping it is exactly how 52k taxdome chunks
 * came to carry `enrichedAt` over no signals (bd tea-rags-mcp-fxio5).
 */

import { describe, expect, it } from "vitest";

import { bareStampableChunkIds } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";

const REQUESTED = new Map([
  [
    "src/a.ts",
    [
      { chunkId: "a1", startLine: 1, endLine: 2 },
      { chunkId: "a2", startLine: 3, endLine: 4 },
    ],
  ],
  ["README.md", [{ chunkId: "r1", startLine: 1, endLine: 9 }]],
]);

describe("bareStampableChunkIds (bd tea-rags-mcp-39xca.2)", () => {
  it("offers every requested chunk when the provider leaves omitted chunks to the caller", () => {
    expect(bareStampableChunkIds({}, REQUESTED)).toEqual(new Set(["a1", "a2", "r1"]));
  });

  it("offers none when the provider settles chunks explicitly — a chunk it omits is unsettled", () => {
    expect(bareStampableChunkIds({ settlesChunksExplicitly: true }, REQUESTED)).toBeUndefined();
  });
});
