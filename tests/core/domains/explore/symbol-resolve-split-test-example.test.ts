/**
 * An oversized test EXAMPLE (bd tea-rags-mcp-msv3l) cut into `#partN` parts by
 * the chunker's hard cap (bd tea-rags-mcp-y5vx4). Both halves read the same
 * base-id rule — `splitFragmentBase`, a part's `parentSymbolId` — so the parts
 * group under the example id, find_symbol on that id stitches them back into
 * exactly the chunk the kernel emitted, and the scope outline lists the example
 * once, by its base id.
 *
 * The parts come from the real engine: the kernel emits the example, the
 * TreeSitterChunker splits it, and the payload fields find_symbol reads are
 * copied off the resulting chunks unchanged.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HookContext, TestScope } from "../../../../src/core/contracts/types/chunker.js";
import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../src/core/domains/language/index.js";
import { produceTestScopeChunks } from "../../../../src/core/domains/language/kernel/test-scope-chunks.js";
import { testScopeChunkerHook } from "../../../../src/core/domains/language/typescript/chunking/test-scope-chunker.js";
import type { ChunkerConfig } from "../../../../src/core/types.js";

const PATH = "src/cart.test.ts";
const MAX_CHUNK_SIZE = 400;

const assertions = Array.from(
  { length: 24 },
  (_, i) => `    expect(cart.lineItem(${i}).total).toEqual(expectedTotals[${i}]);`,
);
const exampleLines = ['  it("totals every line item it holds", () => {', ...assertions, "  });"];
const code = [
  'describe("Cart", () => {',
  "  const cart = buildCartWithManyLineItems();",
  ...exampleLines,
  "});",
  "",
].join("\n");
const exampleStart = 3;
const exampleEnd = exampleStart + exampleLines.length - 1;

const scope: TestScope = {
  name: 'describe "Cart"',
  startLine: 1,
  endLine: exampleEnd + 1,
  setupLines: [{ text: "  const cart = buildCartWithManyLineItems();", sourceLine: 2 }],
  otherLines: [],
  examples: [
    {
      name: 'it "totals every line item it holds"',
      text: exampleLines.join("\n"),
      startLine: exampleStart,
      endLine: exampleEnd,
    },
  ],
  children: [],
};
const scopeId = 'Cart.describe "Cart"';
const exampleId = `${scopeId}.it "totals every line item it holds"`;

describe("find_symbol over a test example split into #partN parts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function indexedPayloads() {
    vi.spyOn(testScopeChunkerHook, "process").mockImplementation((ctx: HookContext) => {
      ctx.bodyChunks = produceTestScopeChunks(scope, "Cart", { maxChunkSize: MAX_CHUNK_SIZE });
      ctx.skipChildren = true;
    });
    const config: ChunkerConfig = { chunkSize: 300, chunkOverlap: 0, maxChunkSize: MAX_CHUNK_SIZE };
    const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
    const chunks = await chunker.chunk(code, PATH, "typescript");
    return chunks
      .filter((c) => c.metadata.chunkType === "test")
      .map((c, i) => ({
        id: `chunk-${i}`,
        payload: {
          symbolId: c.metadata.symbolId,
          parentSymbolId: c.metadata.parentSymbolId,
          parentType: c.metadata.parentType,
          chunkType: c.metadata.chunkType,
          name: c.metadata.name,
          relativePath: PATH,
          language: "typescript",
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
        },
      }))
      .reverse(); // a Qdrant scroll returns points in no particular order
  }

  it("the chunker emits the example only as test_scope parts based on the example id", async () => {
    const payloads = await indexedPayloads();

    expect(payloads.length).toBeGreaterThan(1);
    for (const { payload } of payloads) {
      expect(payload.symbolId).toMatch(/#part\d+$/);
      expect(payload.parentSymbolId).toBe(exampleId);
      expect(payload.parentType).toBe("test_scope");
    }
  });

  it("stitches the parts back into exactly the chunk the engine would have indexed unsplit", async () => {
    // The engine prepends the claimed container's header to every hook body
    // chunk; the kernel's chunk under that header is the unsplit example.
    // The scope's setup leads as its own chunk since bd tea-rags-mcp-5xpq4.
    const kernelChunk = produceTestScopeChunks(scope, "Cart", { maxChunkSize: MAX_CHUNK_SIZE }).find(
      (c) => c.symbolId === exampleId,
    )!;
    const unsplit = `describe("Cart", () => {\n${kernelChunk.content}`;

    const results = resolveSymbols(await indexedPayloads(), exampleId);

    expect(results).toHaveLength(1);
    expect(results[0].payload?.symbolId).toBe(exampleId);
    expect(results[0].payload?.content).toBe(unsplit);
    expect(results[0].payload?.startLine).toBe(exampleStart);
    expect(results[0].payload?.endLine).toBe(exampleEnd);
  });

  it("a scope query outlines the split example once, by its base id", async () => {
    const results = resolveSymbols(await indexedPayloads(), scopeId);

    expect(results).toHaveLength(1);
    expect(results[0].payload?.content).toBe([scopeId, `  ${exampleId}`].join("\n"));
  });
});

/**
 * bd tea-rags-mcp-pi1cl — the kernel budgets an example chunk by
 * `maxChunkSize`, but the engine then prepends the claimed container's header.
 * When the kernel's chunk fits the budget and the header pushes it over, the
 * hard cap cuts it with the inherited setup filling `#part1` and the example's
 * first row landing in `#part2`; `#part1` claims that row, and the stitch drops
 * it as a repeat. find_symbol on the example must still return its `it(` line.
 */
describe("find_symbol over a test example whose container header pushes it past the cap", () => {
  const header = 'describe("Cart totals across every line item and discount rule", () => {';
  const setup = [
    '  const cart = buildCartWithManyLineItems({ currency: "USD", region: "EU", taxMode: "inclusive" });',
    '  const discounts = loadDiscountRules({ seasonal: true, loyalty: true, coupon: "SPRING-2026" });',
    '  const expectedTotal = computeExpectedTotalFromFixtures(cart, discounts, { rounding: "half-even" });',
  ];
  const itLine = '  it("sums", () => {';
  const body = ["    expect(cart.total()).toBe(expectedTotal);", "  });"];
  const tightCode = [header, ...setup, itLine, ...body, "});", ""].join("\n");
  const tightExampleStart = setup.length + 2;
  const tightExampleEnd = tightExampleStart + body.length;
  const tightMax = 380;
  const tightScope: TestScope = {
    name: 'describe "Cart totals across every line item and discount rule"',
    startLine: 1,
    endLine: tightExampleEnd + 1,
    setupLines: setup.map((text, i) => ({ text, sourceLine: i + 2 })),
    otherLines: [],
    examples: [
      {
        name: 'it "sums"',
        text: [itLine, ...body].join("\n"),
        startLine: tightExampleStart,
        endLine: tightExampleEnd,
      },
    ],
    children: [],
  };
  const tightExampleId = 'Cart.describe "Cart totals across every line item and discount rule".it "sums"';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function tightPayloads() {
    vi.spyOn(testScopeChunkerHook, "process").mockImplementation((ctx: HookContext) => {
      // The hook budgets with the config the engine hands it, as the real
      // language hooks do.
      ctx.bodyChunks = produceTestScopeChunks(tightScope, "Cart", ctx.config);
      ctx.skipChildren = true;
    });
    const config: ChunkerConfig = { chunkSize: 300, chunkOverlap: 0, maxChunkSize: tightMax };
    const chunker = new TreeSitterChunker(config, new DefaultSymbolIdComposer(), new LanguageFactory());
    const chunks = await chunker.chunk(tightCode, PATH, "typescript");
    return chunks
      .filter((c) => c.metadata.chunkType === "test")
      .map((c, i) => ({
        id: `chunk-${i}`,
        payload: {
          symbolId: c.metadata.symbolId,
          parentSymbolId: c.metadata.parentSymbolId,
          parentType: c.metadata.parentType,
          chunkType: c.metadata.chunkType,
          name: c.metadata.name,
          relativePath: PATH,
          language: "typescript",
          startLine: c.startLine,
          endLine: c.endLine,
          content: c.content,
        },
      }));
  }

  it("emits the example as one chunk within maxChunkSize, header included", async () => {
    const payloads = await tightPayloads();

    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.symbolId).toBe(tightExampleId);
    expect(payloads[0].payload.content.length).toBeLessThanOrEqual(tightMax);
  });

  it("returns the example's own rows, `it(` line first, from find_symbol", async () => {
    const results = resolveSymbols(await tightPayloads(), tightExampleId);

    expect(results).toHaveLength(1);
    const lines = (results[0].payload?.content as string).split("\n");
    // The example now opens its chunk (its setup is a chunk of its own since
    // bd tea-rags-mcp-5xpq4), so the chunk's trim takes the `it(` row's indent.
    expect(lines.slice(-3)).toEqual([itLine.trim(), ...body]);
    expect(results[0].payload?.startLine).toBe(tightExampleStart);
    expect(results[0].payload?.endLine).toBe(tightExampleEnd);
  });
});
