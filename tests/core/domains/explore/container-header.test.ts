/**
 * A container id answers its class-level header WITH its member outline
 * (progressive disclosure): every header chunk listed in line order with its
 * composition, whole chunks inlined while the per-class header budget holds,
 * the rest kept as addresses behind a truthful notice. Methods stay outline
 * lines. A batch never repeats one header chunk's body twice.
 */
import { describe, expect, it } from "vitest";

import { CONTAINER_HEADER_CHAR_BUDGET } from "../../../../src/core/contracts/types/symbol-batch.js";
import type { ScrollChunk } from "../../../../src/core/domains/explore/chunk-grouping/types.js";
import type { ExploreResult } from "../../../../src/core/domains/explore/strategies/types.js";
import { SymbolBatchDrill } from "../../../../src/core/domains/explore/symbol-batch.js";
import { resolveSymbols } from "../../../../src/core/domains/explore/symbol-resolve.js";

const OWNER = "Middleware::Clusters::Webhooks";
const PATH = "lib/middleware/clusters/webhooks.rb";

const headerChunk = (
  id: string,
  startLine: number,
  endLine: number,
  content: string,
  memberSymbolIds?: string[],
): ScrollChunk => ({
  id,
  payload: {
    symbolId: OWNER,
    name: "Webhooks",
    chunkType: "block",
    parentType: "class",
    parentSymbolId: OWNER,
    relativePath: PATH,
    language: "ruby",
    startLine,
    endLine,
    content,
    ...(memberSymbolIds ? { memberSymbolIds } : {}),
  },
});

const methodChunk = (id: string, name: string, startLine: number): ScrollChunk => ({
  id,
  payload: {
    symbolId: `${OWNER}#${name}`,
    name,
    chunkType: "function",
    parentSymbolId: OWNER,
    parentType: "class",
    relativePath: PATH,
    language: "ruby",
    startLine,
    endLine: startLine + 4,
    content: `def ${name}\n  :${name}_body\nend`,
  },
});

const HEAD_TEXT =
  "class Webhooks < Base\n  WEBHOOKS_PATH = '/webhooks/'\n  WEBHOOKS_MAP = { '/webhooks/stripe' => :sync }.freeze\n  validates :a\n  validates :b\n  enum :mode, {}\n  def initialize(app) = @app = app";
const head = headerChunk("h1", 7, 15, HEAD_TEXT, [
  `${OWNER}::WEBHOOKS_PATH`,
  `${OWNER}::WEBHOOKS_MAP`,
  `${OWNER}.validates :a`,
  `${OWNER}.validates :b`,
  `${OWNER}.enum :mode`,
  `${OWNER}#initialize`,
]);
const call = methodChunk("m1", "call", 20);
const tail = headerChunk("h2", 30, 32, "class Webhooks < Base\n  private\n  attr_reader :app", [`${OWNER}#app`]);

const contentOf = (r: { payload?: Record<string, unknown> }): string =>
  typeof r.payload?.content === "string" ? r.payload.content : "";

describe("container header + outline (find_symbol on a class id)", () => {
  it("lists each header chunk in line order with a composition derived from its member ids", () => {
    const [row] = resolveSymbols([head, call, tail], OWNER);
    const lines = contentOf(row).split("\n");

    expect(lines[0]).toBe("Webhooks");
    expect(lines).toContain("  header 7–15: 2 const, validates ×2, enum :mode, 1 method id");
    expect(lines).toContain("  header 30–32: 1 method id");
    expect(lines.indexOf("  header 7–15: 2 const, validates ×2, enum :mode, 1 method id")).toBeLessThan(
      lines.indexOf("  header 30–32: 1 method id"),
    );
  });

  it("inlines the whole header chunks after the outline while methods stay outline lines", () => {
    const [row] = resolveSymbols([head, call, tail], OWNER);
    const content = contentOf(row);

    expect(content).toContain(`  ${OWNER}#call`);
    expect(content).not.toContain(":call_body");
    expect(content).toContain(`── header 7–15 ──\n${HEAD_TEXT}`);
    expect(content).toContain("── header 30–32 ──\nclass Webhooks < Base\n  private\n  attr_reader :app");
    expect(content.indexOf(`  ${OWNER}#call`)).toBeLessThan(content.indexOf("── header 7–15 ──"));
    expect(row.payload?.kind).toBe("containerHeader");
    expect(row.payload?.mergedChunkIds).toEqual(["h1", "h2"]);
  });

  it("keeps a header chunk past the per-class budget as an address, whole chunks only, with a notice", () => {
    const big = headerChunk(
      "h2",
      30,
      200,
      `class Webhooks < Base\n${"  X = 1\n".repeat(CONTAINER_HEADER_CHAR_BUDGET / 8)}`,
      [`${OWNER}::X`],
    );
    const [row] = resolveSymbols([head, call, big], OWNER);
    const content = contentOf(row);

    expect(content).toContain("── header 7–15 ──");
    expect(content).not.toContain("── header 30–200 ──");
    expect(content).toContain("  header 30–200: 1 const — not inlined");
    expect(content).toContain(`past the ${CONTAINER_HEADER_CHAR_BUDGET}-char per-class header budget`);
    expect(content).not.toContain("  X = 1");
    expect(row.payload?.mergedChunkIds).toEqual(["h1"]);
  });

  it("answers the outline alone, unmarked, when no header chunk fits the budget", () => {
    const huge = headerChunk("h1", 7, 300, "x".repeat(CONTAINER_HEADER_CHAR_BUDGET + 1), [`${OWNER}::BIG`]);
    const [row] = resolveSymbols([huge, call], OWNER);

    expect(contentOf(row)).not.toContain("── header");
    expect(contentOf(row)).toContain("  header 7–300: 1 const — not inlined");
    expect(row.payload?.kind).toBeUndefined();
  });

  it("inlines nothing under metaOnly", () => {
    const [row] = resolveSymbols([head, call, tail], OWNER, true);

    expect(row.payload?.content).toBeUndefined();
    expect(row.payload?.kind).toBeUndefined();
  });

  it("answers a constant id with its own header chunk, as before", () => {
    const [row] = resolveSymbols([head, call, tail], `${OWNER}::WEBHOOKS_MAP`);

    expect(row.id).toBe("h1");
    expect(contentOf(row)).toBe(HEAD_TEXT);
  });
});

describe("SymbolBatchDrill — one header chunk body per batch", () => {
  /** What the symbol strategy's scrolls hand over for `symbol`: its own, its members', and declaring chunks. */
  const scrolledFor = (c: ScrollChunk, symbol: string): boolean => {
    const { symbolId, parentSymbolId, memberSymbolIds } = c.payload;
    return (
      symbolId === symbol ||
      parentSymbolId === symbol ||
      (Array.isArray(memberSymbolIds) && memberSymbolIds.includes(symbol))
    );
  };
  const drillOver = (chunks: ScrollChunk[]) =>
    new SymbolBatchDrill(
      (symbol) =>
        ({
          execute: async () =>
            resolveSymbols(
              chunks.filter((c) => scrolledFor(c, symbol)),
              symbol,
            ) as ExploreResult[],
          codegraphWarning: undefined,
        }) as any,
    );
  const ctx = { collectionName: "c", limit: 50 };

  it("answers several constant ids of one class with one body and points the rest at it", async () => {
    const answer = await drillOver([head, call, tail]).execute(
      [`${OWNER}::WEBHOOKS_PATH`, `${OWNER}::WEBHOOKS_MAP`],
      ctx,
    );

    expect(answer.rows.map((r) => r.request)).toEqual([`${OWNER}::WEBHOOKS_PATH`, `${OWNER}::WEBHOOKS_MAP`]);
    expect(contentOf(answer.rows[0].result)).toBe(HEAD_TEXT);
    expect(answer.rows[1].result.payload?.content).toBeUndefined();
    expect(answer.rows[1].sameChunkAs).toBe(`${OWNER}::WEBHOOKS_PATH`);
    expect(answer.rows[1].result.payload?.symbolId).toBe(`${OWNER}::WEBHOOKS_MAP`);
  });

  it("answers a class id with its constants without repeating the inlined header chunk, in either order", async () => {
    const answer = await drillOver([head, call, tail]).execute([`${OWNER}::WEBHOOKS_MAP`, OWNER], ctx);

    expect(answer.rows[0].result.payload?.content).toBeUndefined();
    expect(answer.rows[0].sameChunkAs).toBe(OWNER);
    expect(contentOf(answer.rows[1].result)).toContain(HEAD_TEXT);
  });

  it("keeps a constant body whose chunk the class row did not inline", async () => {
    const huge = headerChunk("h1", 7, 300, `${HEAD_TEXT}\n${"x".repeat(CONTAINER_HEADER_CHAR_BUDGET)}`, [
      `${OWNER}::WEBHOOKS_MAP`,
    ]);
    const answer = await drillOver([huge, call]).execute([OWNER, `${OWNER}::WEBHOOKS_MAP`], ctx);

    expect(answer.rows[1].sameChunkAs).toBeUndefined();
    expect(contentOf(answer.rows[1].result)).toContain(HEAD_TEXT);
  });
});
