/**
 * find_symbol outline lines carry the member's DECLARED visibility (bd
 * tea-rags-mcp-sqqkz), joined from the codegraph by (relativePath, symbolId).
 *
 * Contract under test:
 *   - a member with a stated level renders `  Svc#helper (private)`;
 *   - a NULL / absent level renders the bare id — never `(public)` by default;
 *   - no resolver (codegraph off), or a resolver that throws, degrades
 *     silently to today's outline;
 *   - one batched lookup per response, and none when nothing is outlined.
 */
import { describe, expect, it, vi } from "vitest";

import type { SymbolVisibilityRow } from "../../../../../src/core/contracts/types/codegraph.js";
import { FileOutlineStrategy } from "../../../../../src/core/domains/explore/strategies/file-outline.js";
import { SymbolSearchStrategy } from "../../../../../src/core/domains/explore/strategies/symbol.js";

const PATH = "src/svc.ts";
const member = (symbolId: string, startLine: number) => ({
  id: `id-${symbolId}`,
  payload: {
    symbolId,
    name: symbolId.split("#")[1],
    chunkType: "function",
    relativePath: PATH,
    content: `${symbolId} body`,
    startLine,
    endLine: startLine + 2,
    parentSymbolId: "Svc",
    parentType: "class_declaration",
  },
});
const CLASS_CHUNK = {
  id: "id-Svc",
  payload: {
    symbolId: "Svc",
    name: "Svc",
    chunkType: "class",
    relativePath: PATH,
    content: "class Svc {}",
    startLine: 1,
    endLine: 40,
  },
};
const MEMBERS = [member("Svc#run", 5), member("Svc#helper", 10), member("Svc#hook", 15), member("Svc#legacy", 20)];
const ROWS: SymbolVisibilityRow[] = [
  { relPath: PATH, symbolId: "Svc#run", visibility: "public" },
  { relPath: PATH, symbolId: "Svc#helper", visibility: "private" },
  { relPath: PATH, symbolId: "Svc#hook", visibility: "protected" },
  { relPath: PATH, symbolId: "Svc#legacy", visibility: null },
  // Namesake in another file must not decorate this outline.
  { relPath: "src/other.ts", symbolId: "Svc#legacy", visibility: "private" },
];

function resolver(rows: SymbolVisibilityRow[] | Error) {
  return {
    resolveSymbolVisibilities: vi.fn(async (_c: string, ids: readonly string[]) => {
      if (rows instanceof Error) throw rows;
      return rows.filter((r) => ids.includes(r.symbolId));
    }),
  };
}

function symbolStrategy(symbol: string, scroll: unknown[], visibility?: ReturnType<typeof resolver>) {
  const qdrant = {
    scrollFiltered: vi
      .fn()
      .mockImplementation(async (_c: string, filter: { must?: { key: string }[] }) =>
        JSON.stringify(filter).includes("parentSymbolId") ? scroll.filter((c) => c !== CLASS_CHUNK) : scroll,
      ),
    getPoint: vi.fn(),
  };
  const registry = { buildMergedFilter: vi.fn().mockReturnValue(undefined) };
  return new SymbolSearchStrategy(
    qdrant as never,
    {} as never,
    [],
    [],
    registry as never,
    { symbol },
    undefined,
    visibility,
  );
}

function fileStrategy(visibility?: ReturnType<typeof resolver>) {
  const qdrant = { scrollFiltered: vi.fn().mockResolvedValue([CLASS_CHUNK, ...MEMBERS]) };
  return new FileOutlineStrategy(qdrant as never, {} as never, [], [], { relativePath: PATH }, visibility);
}

const runExplore = async (strat: unknown, metaOnly = false) =>
  (strat as { executeExplore: (c: unknown) => Promise<{ payload: { content?: string } }[]> }).executeExplore({
    collectionName: "col",
    limit: 10,
    metaOnly,
  });

const DECORATED_MEMBERS = ["  Svc#run (public)", "  Svc#helper (private)", "  Svc#hook (protected)", "  Svc#legacy"];

describe("find_symbol outline — declared visibility (bd tea-rags-mcp-sqqkz)", () => {
  it("class outline: each member line shows its known visibility, NULL stays bare", async () => {
    const vis = resolver(ROWS);
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], vis));

    expect(results).toHaveLength(1);
    expect(results[0].payload.content).toBe(["Svc", ...DECORATED_MEMBERS].join("\n"));
    expect(vis.resolveSymbolVisibilities).toHaveBeenCalledTimes(1);
    expect(vis.resolveSymbolVisibilities.mock.calls[0][0]).toBe("col");
  });

  it("synthesised class outline (no class chunk) is decorated the same way", async () => {
    const results = await runExplore(symbolStrategy("Svc", MEMBERS, resolver(ROWS)));

    expect(results[0].payload.content).toBe(["Svc", ...DECORATED_MEMBERS].join("\n"));
  });

  it("file outline: children lines show their known visibility", async () => {
    const vis = resolver(ROWS);
    const results = await runExplore(fileStrategy(vis));

    expect(results[0].payload.content).toBe(
      [PATH, "  Svc", ...DECORATED_MEMBERS.map((line) => `  ${line}`)].join("\n"),
    );
    expect(vis.resolveSymbolVisibilities).toHaveBeenCalledTimes(1);
  });

  it("no resolver (codegraph off) renders today's outline", async () => {
    const results = await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS]));

    expect(results[0].payload.content).toBe(
      ["Svc", "  Svc#run", "  Svc#helper", "  Svc#hook", "  Svc#legacy"].join("\n"),
    );
  });

  it("a throwing resolver (codegraph unreadable) degrades silently to today's outline", async () => {
    const results = await runExplore(fileStrategy(resolver(new Error("lock held"))));

    expect(results[0].payload.content).toBe(
      [PATH, "  Svc", "    Svc#run", "    Svc#helper", "    Svc#hook", "    Svc#legacy"].join("\n"),
    );
  });

  it("a method lookup (no outline rendered) does not consult the resolver", async () => {
    const vis = resolver(ROWS);
    const results = await runExplore(symbolStrategy("Svc#helper", [member("Svc#helper", 10)], vis));

    expect(results[0].payload.content).toBe("Svc#helper body");
    expect(vis.resolveSymbolVisibilities).not.toHaveBeenCalled();
  });

  it("metaOnly (no content to decorate) does not consult the resolver", async () => {
    const vis = resolver(ROWS);
    await runExplore(symbolStrategy("Svc", [CLASS_CHUNK, ...MEMBERS], vis), true);

    expect(vis.resolveSymbolVisibilities).not.toHaveBeenCalled();
  });
});
