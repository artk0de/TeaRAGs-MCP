/**
 * The test-chunk link keys (bd tea-rags-mcp-f3gq0) — one list shared by the
 * chunker's `testChunkLinks` and the point payload's `toChunkPointInput`. A key
 * missing from either side was dropped silently twice (5xpq4, g5i0a); the list
 * is now a single const, and this pins that every key of it survives the
 * chunk -> pipeline-chunk projection.
 */

import { describe, expect, it } from "vitest";

import {
  TEST_CHUNK_LINK_METADATA_KEYS,
  type TestChunkLinkMetadataKey,
} from "../../../../../src/core/contracts/types/chunker.js";
import { toChunkPointInput } from "../../../../../src/core/domains/ingest/pipeline/chunk-point-payload.js";
import type { CodeChunk } from "../../../../../src/core/types.js";

// Compile-time: every listed key is a real CodeChunk metadata key.
const keysAreMetadataKeys: TestChunkLinkMetadataKey extends keyof CodeChunk["metadata"] ? true : never = true;

function sentinel(key: string): unknown {
  if (key === "memberRowCounts") return [1, 2];
  if (key === "memberSymbolIds") return ["a", "b"];
  return [{ start: 1, end: 2 }];
}

describe("TEST_CHUNK_LINK_METADATA_KEYS", () => {
  it("lists the four link keys", () => {
    expect([...TEST_CHUNK_LINK_METADATA_KEYS].sort()).toEqual([
      "memberLineRanges",
      "memberRowCounts",
      "memberSymbolIds",
      "scopeLineRanges",
    ]);
    expect(keysAreMetadataKeys).toBe(true);
  });

  it("survives toChunkPointInput for every key of the list", () => {
    const metadata = {
      filePath: "a.ts",
      language: "typescript",
      chunkIndex: 0,
      ...Object.fromEntries(TEST_CHUNK_LINK_METADATA_KEYS.map((key) => [key, sentinel(key)])),
    } as CodeChunk["metadata"];
    const chunk: CodeChunk = { content: "x", startLine: 1, endLine: 2, metadata };

    const projected = toChunkPointInput(chunk, []).metadata as unknown as Record<string, unknown>;

    for (const key of TEST_CHUNK_LINK_METADATA_KEYS) {
      expect(projected[key], key).toEqual(sentinel(key));
    }
  });
});
