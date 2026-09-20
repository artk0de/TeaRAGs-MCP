/**
 * Swift tier-1 end to end, at the unit seam: the fixture .swift files go
 * through the REAL tree-sitter-swift grammar and the REAL chunker (so the
 * payloads carry the composed symbolIds), and the resulting chunks are fed to
 * the REAL find_symbol strategies with only the storage scroll mocked — the
 * same seam `strategies/file-outline.test.ts` and `strategies/symbol.test.ts`
 * already standardize on. Proves the three things tier 1 buys Swift:
 *
 *   1. `find_symbol(relativePath:)` — a file outline naming every member.
 *   2. `find_symbol(symbol:)` — class outline for a type, merged body for an
 *      oversized method whose split windows share one symbolId.
 *   3. `hybrid_search`'s BM25 leg — the sparse vector a Swift symbol query
 *      generates shares tokens with the fixture chunks' own vectors (the
 *      server applies IDF; the token overlap is the client-side half).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { codeTokenize, generateSparseVector } from "../../../../../src/core/adapters/qdrant/sparse.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";
import { TreeSitterChunker } from "../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../src/core/types.js";

const FIXTURES = join("tests/__fixtures__/sample-swift");
const INVOICE_REL = "Sources/Payables/Invoice.swift";

/** Real chunks from the real grammar, shaped as Qdrant scroll hits. */
async function invoiceScrollChunks(): Promise<ScrollChunk[]> {
  const chunker = new TreeSitterChunker(
    { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
  const code = readFileSync(join(FIXTURES, "Invoice.swift"), "utf8");
  const chunks: CodeChunk[] = await chunker.chunk(code, INVOICE_REL, "swift");
  return chunks.map((c, i) => ({
    id: `swift-${i}`,
    payload: {
      ...c.metadata,
      content: c.content,
      startLine: c.startLine,
      endLine: c.endLine,
      relativePath: INVOICE_REL,
      language: "swift",
    },
  }));
}

describe("swift tier 1 — find_symbol over real fixture chunks", () => {
  const mockScrollFiltered = vi.fn();
  const mockRerank = vi.fn((r: unknown[]) => r);

  const qdrant = { scrollFiltered: mockScrollFiltered } as any;
  const reranker = {
    rerank: mockRerank,
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn().mockReturnValue(undefined),
  } as any;
  const buildRegistry = () => ({ buildMergedFilter: vi.fn().mockReturnValue(undefined) }) as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("find_symbol(relativePath:) returns a file outline naming every swift member", async () => {
    const chunks = await invoiceScrollChunks();
    mockScrollFiltered.mockResolvedValue(chunks);

    const strategy = new FileOutlineStrategy(qdrant, reranker, [], [], { relativePath: INVOICE_REL });
    const results = await strategy.execute({ collectionName: "c", limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].payload?.relativePath).toBe(INVOICE_REL);
    const outline = String(results[0].payload?.content);
    expect(outline).toContain("InvoiceLine#init");
    expect(outline).toContain("InvoiceLine#scale");
    expect(outline).toContain("InvoiceState#transition");
    expect(outline).toContain("Invoice#init~2");
    expect(outline).toContain("Invoice.empty");
    expect(outline).toContain("Invoice#totalsByQuantity");
  });

  it("find_symbol(symbol:) returns a class outline listing its members", async () => {
    const chunks = await invoiceScrollChunks();
    mockScrollFiltered.mockResolvedValue(chunks);

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "Invoice" });
    const results = await strategy.execute({ collectionName: "c", limit: 50 });

    const outline = results.find((r) => r.payload?.symbolId === "Invoice");
    expect(outline).toBeDefined();
    const content = String(outline?.payload?.content);
    expect(content).toContain("Invoice#add");
    expect(content).toContain("Invoice#total");
    // Members' bodies stay out of the outline — that is find_symbol's contract.
    expect(content).not.toContain("lines.append(line)");
  });

  it("find_symbol(symbol:) merges the split windows of an oversized function into one body", async () => {
    // The oversized-symbolId invariant (tree-sitter.oversized-symbolid.test.ts)
    // is engine-generic: every split window of one oversized declaration shares
    // that declaration's symbolId. Mirror the typescript precedent on swift so
    // the merge leg of find_symbol is proven on a REAL multi-window chunk set,
    // not a synthetic one.
    const chunker = new TreeSitterChunker(
      { chunkSize: 800, chunkOverlap: 50, maxChunkSize: 1500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
    const body = "    findings += inspect(record: 1)\n".repeat(400);
    const code = `func bigAudit() -> Int {
    var findings = 0
${body}    return findings
}

func inspect(record: Int) -> Int {
    return record % 2
}
`;
    const raw: CodeChunk[] = await chunker.chunk(code, "Sources/Audit.swift", "swift");
    const windows = raw.filter((c) => c.metadata.symbolId === "bigAudit");
    expect(windows.length, "the oversized function must split into several windows").toBeGreaterThan(1);

    const scroll: ScrollChunk[] = raw.map((c, i) => ({
      id: `audit-${i}`,
      payload: {
        ...c.metadata,
        content: c.content,
        startLine: c.startLine,
        endLine: c.endLine,
        relativePath: "Sources/Audit.swift",
        language: "swift",
      },
    }));
    mockScrollFiltered.mockResolvedValue(scroll);

    const strategy = new SymbolSearchStrategy(qdrant, reranker, [], [], buildRegistry(), { symbol: "bigAudit" });
    const results = await strategy.execute({ collectionName: "c", limit: 50 });

    const merged = results.find((r) => r.payload?.symbolId === "bigAudit");
    expect(merged).toBeDefined();
    const mergedBody = String(merged?.payload?.content);
    expect(mergedBody).toContain("func bigAudit()");
    expect(mergedBody).toContain("return findings");
    expect(merged?.payload?.mergedChunkIds?.length).toBe(windows.length);
  });
});

describe("swift tier 1 — hybrid BM25 leg", () => {
  it("a Swift symbol query tokenizes into tokens the fixture chunks carry", async () => {
    const chunks = await invoiceScrollChunks();
    const queryTokens = codeTokenize("totalsByQuantity Invoice");
    expect(queryTokens).toContain("totals");
    expect(queryTokens).toContain("quantity");
    expect(queryTokens).toContain("invoice");

    const chunkTokens = new Set(chunks.flatMap((c) => codeTokenize(String(c.payload.content))));
    for (const token of queryTokens) {
      expect(chunkTokens.has(token), `token "${token}" missing from fixture chunks`).toBe(true);
    }
  });

  it("generates overlapping sparse vectors for a symbol query and its chunk", async () => {
    const chunks = await invoiceScrollChunks();
    const target = chunks.find((c) => c.payload.symbolId === "Invoice#totalsByQuantity");
    expect(target).toBeDefined();

    const queryVector = generateSparseVector("Invoice totalsByQuantity");
    const chunkVector = generateSparseVector(String(target?.payload.content));
    const queryIndices = new Set(queryVector.indices);
    const shared = chunkVector.indices.filter((i: number) => queryIndices.has(i));
    expect(shared.length).toBeGreaterThan(0);
  });
});
