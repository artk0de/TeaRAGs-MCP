import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookContext } from "../../../../../../src/core/contracts/types/chunker.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { testScopeChunkerHook } from "../../../../../../src/core/domains/language/typescript/chunking/test-scope-chunker.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

/**
 * A hook body chunk may name its own `parentType` (bd tea-rags-mcp-msv3l): a
 * test example's parent is a test scope, not the AST container the engine
 * would otherwise stamp. Without an override the engine keeps the container's
 * node type.
 */
describe("TreeSitterChunker hook-provided parentType", () => {
  const config: ChunkerConfig = { chunkSize: 800, chunkOverlap: 50, maxChunkSize: 2500 };
  const code = [
    'describe("Cart", () => {',
    '  it("starts empty with no line items at all", () => {',
    "    expect(new Cart().items).toEqual([]);",
    "  });",
    "});",
    "",
  ].join("\n");

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function claimWith(parentType: string | undefined): void {
    vi.spyOn(testScopeChunkerHook, "process").mockImplementation((ctx: HookContext) => {
      ctx.bodyChunks = [
        {
          content: 'it("starts empty with no line items at all", () => {\n  expect(new Cart().items).toEqual([]);\n});',
          startLine: 2,
          endLine: 4,
          chunkType: "test",
          symbolId: 'Cart.describe "Cart".it "starts empty"',
          name: 'it "starts empty"',
          parentSymbolId: 'Cart.describe "Cart"',
          ...(parentType !== undefined ? { parentType } : {}),
        },
      ];
      ctx.skipChildren = true;
    });
  }

  async function chunkSpec() {
    const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
    const chunks = await chunker.chunk(code, "src/cart.test.ts", "typescript");
    return chunks.filter((c) => c.metadata.chunkType === "test");
  }

  it("stamps the hook's parentType on the chunk", async () => {
    claimWith("test_scope");

    const [chunk] = await chunkSpec();

    expect(chunk.metadata.parentType).toBe("test_scope");
  });

  it("keeps the container's AST type when the hook names none", async () => {
    claimWith(undefined);

    const [chunk] = await chunkSpec();

    expect(chunk.metadata.parentType).toBe("call_expression");
  });
});
