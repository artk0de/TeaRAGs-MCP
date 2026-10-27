/**
 * Answer banners (bd tea-rags-mcp-nknkg.3): a one-line imperative placed BEFORE
 * the answer data moves the next call; the same text as a trailing field does
 * not. Banners fire only at three decision points, never anywhere else.
 */
import { describe, expect, it, vi } from "vitest";

import {
  answerBannerFor,
  BODY_SHOWN_BANNER,
  emptyGraphBanner,
  SEARCH_ANCHOR_BANNER,
  symbolShortName,
} from "../../../../src/core/api/tools/answer-banner.js";
import type { McpToolResult } from "../../../../src/core/api/tools/format.js";
import { createRegisterTool } from "../../../../src/core/api/tools/middleware/error-handler.js";

const structured = (structuredContent: Record<string, unknown>): McpToolResult => ({ structuredContent, content: [] });
const textJson = (answer: Record<string, unknown>): McpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(answer) }],
});

const searchRows = {
  results: {
    columns: ["payload.relativePath", "payload.symbolId", "payload.startLine", "payload.endLine"],
    rows: [
      ["src/payouts/api/payouts-controller.ts", "PayoutsController#create", 20, 61],
      ["src/payouts/settlement/payout-settler.ts", "PayoutSettler#settle", 40, 96],
    ],
  },
};
const methodBody = {
  results: [
    {
      payload: {
        relativePath: "src/payouts/settlement/payout-settler.ts",
        symbolId: "PayoutSettler#settle",
        startLine: 40,
        endLine: 96,
        content: "async settle(payout: Payout): Promise<Settlement> {\n  return this.book(payout);\n}",
      },
    },
  ],
};
const classOutline = {
  results: [
    {
      payload: {
        relativePath: "src/core/api/internal/facades/explore-facade.ts",
        symbolId: "ExploreFacade",
        startLine: 74,
        endLine: 140,
        content: "ExploreFacade\n  ExploreFacade#constructor (public)\n  ExploreFacade#semanticSearch (public)",
      },
    },
  ],
};
const noEdges = {
  empty: { reason: "noEdges", message: "Checkout::Flow#step_ready? is in the codegraph with no callers." },
  callers: [],
};

describe("banner texts", () => {
  it("stay one line, ≤ ~200 chars, and never name a concrete row", () => {
    for (const text of [SEARCH_ANCHOR_BANNER, BODY_SHOWN_BANNER, emptyGraphBanner("get_callers", "step_ready?")]) {
      expect(text.startsWith("↳ ")).toBe(true);
      expect(text).not.toContain("\n");
      expect(text.length).toBeLessThanOrEqual(200);
    }
    expect(SEARCH_ANCHOR_BANNER).toBe(
      "↳ Anchor = the row whose symbol names the asked behaviour (any row, not row 1) → get_callees(symbolId: <anchor>, depth: 2) → ONE find_symbol(symbols:[needed ids]).",
    );
    expect(BODY_SHOWN_BANNER).toBe("↳ Body shown in full — answer from it; do not reopen the file.");
    expect(emptyGraphBanner("get_callers", "step_ready?")).toBe(
      '↳ Empty ≠ no callers: dynamic/DSL/job call sites are not in the graph — default code search tool "step_ready?" <src dir> (literal, -l) before concluding.',
    );
    expect(emptyGraphBanner("get_callees", "settle")).toContain("Empty ≠ no callees:");
  });
});

describe("symbolShortName", () => {
  it.each([
    ["Class#m", "m"],
    ["Class.m", "m"],
    ["Mod::Class#m?", "m?"],
    ["Checkout::Flow#step_ready?", "step_ready?"],
    ["fn", "fn"],
  ])("%s → %s", (symbolId, expected) => {
    expect(symbolShortName(symbolId)).toBe(expected);
  });
});

describe("answerBannerFor — search answers with rows", () => {
  it.each(["semantic_search", "hybrid_search", "rank_chunks", "find_similar"])(
    "%s with symbol rows → anchor banner",
    (tool) => {
      expect(answerBannerFor(tool, { query: "settle payout" }, structured(searchRows))).toBe(SEARCH_ANCHOR_BANNER);
    },
  );

  it("a single-row (untabulated) answer also gets it", () => {
    expect(answerBannerFor("semantic_search", {}, structured(methodBody))).toBe(SEARCH_ANCHOR_BANNER);
  });

  it("no rows, file-level rows without symbolId → no banner", () => {
    expect(answerBannerFor("semantic_search", {}, structured({ results: [] }))).toBeUndefined();
    const fileRows = { results: [{ payload: { relativePath: "a.ts" } }, { payload: { relativePath: "b.ts" } }] };
    expect(answerBannerFor("hybrid_search", {}, structured(fileRows))).toBeUndefined();
  });
});

describe("answerBannerFor — find_symbol bodies", () => {
  it("single-symbol method body → body banner", () => {
    expect(answerBannerFor("find_symbol", { symbol: "PayoutSettler#settle" }, structured(methodBody))).toBe(
      BODY_SHOWN_BANNER,
    );
  });

  it("symbols batch with bodies → body banner", () => {
    const batch = {
      results: {
        columns: ["payload.request", "payload.symbolId", "payload.relativePath", "payload.content"],
        rows: [
          ["formatMcpResponse", "formatMcpResponse", "src/a.ts", "function formatMcpResponse() {\n  return 1;\n}"],
          ["Checkout::Flow#step_ready?", "Checkout::Flow#step_ready?", "app/flow.rb", "def step_ready?\n  true\nend"],
        ],
      },
      missing: [],
    };
    expect(answerBannerFor("find_symbol", { symbols: ["formatMcpResponse", "x"] }, structured(batch))).toBe(
      BODY_SHOWN_BANNER,
    );
  });

  it("class outline, file outline, directory listing, metaOnly, relativePath mode → no banner", () => {
    expect(answerBannerFor("find_symbol", { symbol: "ExploreFacade" }, structured(classOutline))).toBeUndefined();
    const fileOutline = { results: [{ payload: { relativePath: "src/a.ts", content: "src/a.ts\n  foo\n  bar" } }] };
    expect(answerBannerFor("find_symbol", { symbol: "src/a.ts" }, structured(fileOutline))).toBeUndefined();
    const dir = { results: [], directory: { kind: "directory", dir: "src", subdirs: [], total: 0 } };
    expect(answerBannerFor("find_symbol", { relativePath: "src" }, structured(dir))).toBeUndefined();
    expect(answerBannerFor("find_symbol", { relativePath: "src/a.ts" }, structured(methodBody))).toBeUndefined();
    expect(
      answerBannerFor("find_symbol", { symbol: "PayoutSettler#settle", metaOnly: true }, structured(methodBody)),
    ).toBeUndefined();
  });
});

describe("answerBannerFor — empty graph answers", () => {
  it("get_callers noEdges → banner with the requested symbol's short name", () => {
    expect(answerBannerFor("get_callers", { symbolId: "Checkout::Flow#step_ready?" }, textJson(noEdges))).toBe(
      emptyGraphBanner("get_callers", "step_ready?"),
    );
  });

  it("get_callees unknownSymbol without suggestions → banner", () => {
    const unknown = { empty: { reason: "unknownSymbol", message: "…" }, callees: [] };
    expect(answerBannerFor("get_callees", { symbolId: "Foo.bar" }, textJson(unknown))).toBe(
      emptyGraphBanner("get_callees", "bar"),
    );
  });

  it("non-empty graph, testChunk, suggestions, file scope → no banner", () => {
    const rows = { callers: [{ sourceSymbolId: "a", sourceRelPath: "a.ts" }] };
    expect(answerBannerFor("get_callers", { symbolId: "X#y" }, textJson(rows))).toBeUndefined();
    const testChunk = { empty: { reason: "testChunk", message: "…" }, callers: [] };
    expect(answerBannerFor("get_callers", { symbolId: "X#y" }, textJson(testChunk))).toBeUndefined();
    const suggested = { empty: { reason: "unknownSymbol", message: "…", suggestions: ["X.y"] }, callers: [] };
    expect(answerBannerFor("get_callers", { symbolId: "X#y" }, textJson(suggested))).toBeUndefined();
    const fileScope = { empty: { reason: "unknownFile", message: "…" }, importers: [] };
    expect(answerBannerFor("get_callers", { relativePath: "a.ts" }, textJson(fileScope))).toBeUndefined();
  });
});

describe("answerBannerFor — elsewhere", () => {
  it("errors and other tools → no banner", () => {
    expect(answerBannerFor("semantic_search", {}, { ...structured(searchRows), isError: true })).toBeUndefined();
    expect(answerBannerFor("get_index_status", {}, structured(searchRows))).toBeUndefined();
    expect(answerBannerFor("trace_path", { symbolId: "X#y" }, textJson(noEdges))).toBeUndefined();
  });
});

describe("registered tools carry the banner as the FIRST content item", () => {
  const register = (name: string, result: McpToolResult) => {
    const server = { registerTool: vi.fn() };
    createRegisterTool()(
      server as never,
      name,
      { description: "d" } as never,
      vi.fn().mockResolvedValue(result) as never,
    );
    return server.registerTool.mock.calls[0][2] as (args: unknown, extra: unknown) => Promise<McpToolResult>;
  };

  it("search: banner first, existing content after, structuredContent unchanged", async () => {
    const original = {
      structuredContent: structuredClone(searchRows),
      content: [{ type: "text" as const, text: "dense down" }],
    };
    const result = await register("semantic_search", original)({ query: "q" }, {});
    expect(result.content).toEqual([
      { type: "text", text: SEARCH_ANCHOR_BANNER },
      { type: "text", text: "dense down" },
    ]);
    expect(result.structuredContent).toEqual(searchRows);
  });

  it("graph: banner precedes the JSON text answer", async () => {
    const result = await register("get_callers", textJson(noEdges))({ symbolId: "Checkout::Flow#step_ready?" }, {});
    expect(result.content[0].text).toBe(emptyGraphBanner("get_callers", "step_ready?"));
    expect(JSON.parse(result.content[1].text)).toEqual(noEdges);
  });

  it("a thrown error answers without a banner", async () => {
    const server = { registerTool: vi.fn() };
    createRegisterTool()(
      server as never,
      "semantic_search",
      { description: "d" } as never,
      vi.fn().mockRejectedValue(new Error("boom")) as never,
    );
    const handler = server.registerTool.mock.calls[0][2] as (a: unknown, e: unknown) => Promise<McpToolResult>;
    const result = await handler({}, {});
    expect(result.isError).toBe(true);
    expect(result.content.some((c) => c.text.startsWith("↳ "))).toBe(false);
  });
});
