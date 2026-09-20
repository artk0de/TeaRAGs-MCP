/**
 * Registering a hook chain must not move Swift chunk output on code that has
 * none of the shapes the chain exists for.
 *
 * Two engine branches key on "does this language have hooks at all", not on
 * what the hooks do: `chunkWithChildExtraction` stops emitting its narrow
 * parent class chunk, and `canRecurseAsContainer` starts treating every child
 * with chunkable grandchildren as a container. Both are covered by the chain —
 * by `swiftContainerBodyChunkerHook` and `swiftNestedFunctionFilterHook`
 * respectively — and this test is what proves the cover is exact: the same
 * fixtures chunked with and without the chain, compared chunk for chunk on
 * symbolId, chunkType, line range and content.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/index.js";
import { SwiftLanguage } from "../../../../../../src/core/domains/language/swift/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";
import { createSwiftChunkerWithHooks } from "./__helpers__/swift-chunking.js";

const FIXTURES = join("tests/__fixtures__/sample-swift");

/**
 * A chunker over a Swift provider with NO hook chain. Built explicitly rather
 * than through `LanguageFactory`, so the comparison keeps its meaning once the
 * chain is wired into `SwiftLanguage` itself.
 */
function createSwiftChunkerWithoutHooks(): TreeSitterChunker {
  const base = new SwiftLanguage();
  const provider = { kernel: base.kernel, chunkerHooks: { ...base.chunkerHooks, hooks: undefined } };
  return new TreeSitterChunker(
    { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
    new DefaultSymbolIdComposer(),
    { create: () => provider, supported: () => ["swift"], signalFloors: () => new Map() },
  );
}

function fingerprint(chunks: CodeChunk[]): string[] {
  return chunks.map(
    (c) => `${c.metadata.symbolId} | ${c.metadata.chunkType} | ${c.startLine}-${c.endLine} | ${c.content}`,
  );
}

describe("swift hook chain parity", () => {
  const fixtures = readdirSync(FIXTURES).filter((name) => name.endsWith(".swift"));

  it("finds the Swift fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("emits identical chunks for %s with and without the chain", async (name) => {
    const relativePath = join(FIXTURES, name);
    const code = readFileSync(relativePath, "utf8");

    const withoutHooks = await createSwiftChunkerWithoutHooks().chunk(code, relativePath, "swift");
    const withHooks = await createSwiftChunkerWithHooks().chunk(code, relativePath, "swift");

    expect(fingerprint(withHooks)).toEqual(fingerprint(withoutHooks));
  });
});
