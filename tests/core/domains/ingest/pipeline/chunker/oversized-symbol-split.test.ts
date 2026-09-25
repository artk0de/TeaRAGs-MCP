/**
 * bd tea-rags-mcp-y5vx4 — an oversized symbol is split on the statement
 * boundaries of its body, never inside a block that fits a part on its own,
 * and its parts are numbered `#part1..#partN` exactly once.
 *
 * Table-driven over every AST-chunked language the factory registers: a new
 * language without a fixture fails the coverage test instead of going
 * unchecked. Each fixture's method holds every block-forming construct of its
 * grammar plus one loop too large for a part, whose own body must then be
 * split by the same rule with the loop header carried as context.
 */

import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";
import { OVERSIZED_SYMBOL_FIXTURES } from "./__helpers__/oversized-symbol-fixtures.js";

const BUDGET = 600;
const factory = new LanguageFactory();

/** Every language chunked through tree-sitter — derived, never hand-listed. */
const AST_LANGUAGES = factory.supported().filter((lang) => {
  const hooks = factory.create(lang).chunkerHooks;
  return hooks !== undefined && hooks.isDocumentation !== true;
});

interface NativeNode {
  type: string;
  isNamed: boolean;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: NativeNode[];
  text: string;
}

async function parse(language: string, code: string): Promise<NativeNode> {
  const { kernel } = factory.create(language);
  const mod = (await kernel.loadModule()) as Record<string, unknown>;
  const grammar = (kernel.extractLanguage ? kernel.extractLanguage(mod) : (mod.default ?? mod)) as Parser.Language;
  const parser = new Parser();
  parser.setLanguage(grammar);
  return parser.parse(code).rootNode;
}

function walk(node: NativeNode, visit: (n: NativeNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Last 0-based row holding the node's text (a node ending at column 0 ends on the row above). */
function lastRowOf(node: NativeNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

/** A construct that opens with a keyword / punctuation token rather than a complete child. */
function isOpener(node: NativeNode): boolean {
  return node.children.length > 0 && !node.children[0].isNamed;
}

/** Characters of source rows `[from, to]` joined by newlines — the splitter's unit size. */
function rowsSize(codeLines: string[], from: number, to: number): number {
  return codeLines.slice(from, to + 1).join("\n").length;
}

/**
 * Lines of `part.content` that precede its own rows: the container hierarchy
 * prefix (a member's parts, bd tea-rags-mcp-jgb5a) followed by the splitter's
 * context prefix.
 */
function prefixOf(part: CodeChunk): string[] {
  const lines = part.content.split("\n");
  const own = part.endLine - part.startLine + 1;
  return lines.slice(0, Math.max(0, lines.length - own));
}

/**
 * The container hierarchy prefix every part of a MEMBER opens with — what
 * precedes `#part1`'s own rows, since `#part1` carries no splitter context.
 * Empty for a top-level symbol.
 */
function hierarchyOf(parts: CodeChunk[]): string[] {
  return prefixOf(parts[0]);
}

/** The splitter's context prefix of a part: its prefix past the hierarchy lines. */
function contextOf(part: CodeChunk, hierarchy: string[]): string[] {
  return prefixOf(part).slice(hierarchy.length);
}

function partsOf(chunks: CodeChunk[], base: string): CodeChunk[] {
  return chunks.filter((c) => c.metadata.parentSymbolId === base && /#part\d+$/.test(c.metadata.symbolId ?? ""));
}

describe("oversized symbol split (bd tea-rags-mcp-y5vx4)", () => {
  it("has a fixture for every AST-chunked language the factory registers", () => {
    expect(AST_LANGUAGES.length).toBeGreaterThan(0);
    for (const lang of AST_LANGUAGES) {
      expect(OVERSIZED_SYMBOL_FIXTURES[lang], `missing oversized-symbol fixture for ${lang}`).toBeDefined();
    }
  });

  describe.each(AST_LANGUAGES)("%s", (language) => {
    const fixture = OVERSIZED_SYMBOL_FIXTURES[language];
    const codeLines = fixture.code.split("\n");
    let chunks: CodeChunk[];
    let parts: CodeChunk[];
    let root: NativeNode;

    beforeAll(async () => {
      const chunker = new TreeSitterChunker(
        { chunkSize: BUDGET, chunkOverlap: 100, maxChunkSize: BUDGET },
        new DefaultSymbolIdComposer(),
        factory,
      );
      chunks = await chunker.chunk(fixture.code, fixture.filePath, language);
      parts = partsOf(chunks, fixture.baseSymbolId);
      root = await parse(language, fixture.code);
    });

    it("the fixture exercises every listed construct inside the symbol", () => {
      const present = new Set<string>();
      walk(root, (n) => {
        if (n.endPosition.row > n.startPosition.row) present.add(n.type);
      });
      for (const construct of fixture.constructs) {
        expect(present, `${language} fixture has no multi-row ${construct}`).toContain(construct);
      }
    });

    it("emits the symbol as #part1..#partN, numbered once, in order, under the base symbolId", () => {
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.map((p) => p.metadata.symbolId)).toEqual(
        parts.map((_, i) => `${fixture.baseSymbolId}#part${i + 1}`),
      );
      const sameBase = chunks.filter((c) => (c.metadata.symbolId ?? "").startsWith(`${fixture.baseSymbolId}#part`));
      expect(sameBase).toHaveLength(parts.length);
      expect(chunks.some((c) => c.metadata.symbolId === fixture.baseSymbolId)).toBe(false);
      for (const part of parts) expect(part.metadata.parentSymbolId).toBe(fixture.baseSymbolId);
    });

    it("parts tile the symbol: contiguous line ranges, no overlap, each within the budget", () => {
      for (let i = 1; i < parts.length; i++) {
        expect(parts[i].startLine, `${language} part ${i + 1} start`).toBe(parts[i - 1].endLine + 1);
      }
      for (const part of parts) expect(part.content.length).toBeLessThanOrEqual(BUDGET);
    });

    it("every part of a member opens with the same container hierarchy prefix; a top-level symbol's with none", () => {
      // bd tea-rags-mcp-jgb5a — a member's parts name their container exactly
      // as the unsplit member chunk does.
      const isMember = /[#.]|::/.test(fixture.baseSymbolId);
      const hierarchy = hierarchyOf(parts);
      expect(hierarchy.length, `${language}: hierarchy prefix lines`).toBe(isMember ? 1 : 0);
      for (const part of parts) {
        expect(part.content.split("\n").slice(0, hierarchy.length)).toEqual(hierarchy);
      }
    });

    it("never cuts strictly inside a construct that fits a part on its own", () => {
      const maxPrefix = Math.max(0, ...parts.map((p) => prefixOf(p).reduce((sum, l) => sum + l.length + 1, 0)));
      const symbolFirstRow = parts[0].startLine - 1;
      const symbolLastRow = parts[parts.length - 1].endLine - 1;
      const cutsAfterRow = parts.slice(0, -1).map((p) => p.endLine - 1);
      const checked = new Set(fixture.constructs);
      const violations: string[] = [];
      walk(root, (node) => {
        const first = node.startPosition.row;
        const last = lastRowOf(node);
        if (last <= first || !node.isNamed) return;
        // Only nodes strictly within the symbol — the symbol and its ancestors span every cut.
        if (first < symbolFirstRow || last > symbolLastRow) return;
        if (first === symbolFirstRow && last === symbolLastRow) return;
        const fitsAlone = rowsSize(codeLines, first, last) + maxPrefix <= BUDGET;
        if (!fitsAlone) return;
        for (const cut of cutsAfterRow) {
          if (first <= cut && cut < last) {
            violations.push(
              `${checked.has(node.type) ? "construct " : ""}${node.type} rows ${first + 1}-${last + 1} cut after line ${cut + 1}`,
            );
          }
        }
      });
      expect(violations, `${language}: cuts inside blocks that fit`).toEqual([]);
    });

    it("never ends a part on the row that opens a construct, nor on the bare signature", () => {
      expect(parts[0].endLine, `${language}: first part is the signature alone`).toBeGreaterThan(parts[0].startLine);
      const orphaned: string[] = [];
      for (const part of parts.slice(0, -1)) {
        const cut = part.endLine - 1;
        walk(root, (node) => {
          if (node.startPosition.row !== cut || lastRowOf(node) <= cut || !isOpener(node)) return;
          orphaned.push(`${node.type} opened on line ${cut + 1} ends part ${part.metadata.symbolId}`);
        });
      }
      expect(orphaned, `${language}: opening rows cut off from their body`).toEqual([]);
    });

    it("context prefix lines are the signature and opening rows only — never a plain statement", () => {
      const openingRows = new Set<string>();
      walk(root, (node) => {
        if (lastRowOf(node) > node.startPosition.row && isOpener(node)) {
          openingRows.add(codeLines[node.startPosition.row].trim());
        }
      });
      openingRows.add(codeLines[parts[0].startLine - 1].trim()); // the signature
      const hierarchy = hierarchyOf(parts);
      const strays = parts
        .slice(1)
        .flatMap((p) => contextOf(p, hierarchy).map((l) => l.trim()))
        .filter((l) => !openingRows.has(l));
      expect(strays, `${language}: context lines that open nothing`).toEqual([]);
    });

    it("a later part carries the signature and the oversized loop header as its context", () => {
      const signature = codeLines[parts[0].startLine - 1].trim();
      const hierarchy = hierarchyOf(parts);
      for (const part of parts.slice(1)) {
        expect(contextOf(part, hierarchy)[0]?.trim(), `${language} part context starts at the signature`).toBe(
          signature,
        );
      }
      const insideLoop = parts
        .slice(1)
        .filter((p) => contextOf(p, hierarchy).some((l) => l.trim() === fixture.bigLoopHeader));
      expect(insideLoop.length, `${language}: no part is framed by "${fixture.bigLoopHeader}"`).toBeGreaterThan(0);
    });

    it("find_symbol on the base symbolId reassembles the exact source of the symbol", () => {
      const scroll = parts.map((p, i) => ({
        id: `p${i}`,
        payload: {
          symbolId: p.metadata.symbolId,
          parentSymbolId: p.metadata.parentSymbolId,
          parentType: p.metadata.parentType,
          chunkType: p.metadata.chunkType,
          name: p.metadata.name,
          relativePath: fixture.filePath,
          content: p.content,
          startLine: p.startLine,
          endLine: p.endLine,
          language,
        },
      }));
      const results = resolveSymbols(scroll, fixture.baseSymbolId);
      expect(results).toHaveLength(1);
      const payload = results[0].payload ?? {};
      expect(payload.symbolId).toBe(fixture.baseSymbolId);
      expect(payload.startLine).toBe(parts[0].startLine);
      expect(payload.endLine).toBe(parts[parts.length - 1].endLine);

      const firstRow = parts[0].startLine - 1;
      const lastRow = parts[parts.length - 1].endLine - 1;
      // A member's reassembly opens with its container hierarchy prefix, exactly
      // as the unsplit member chunk does (bd tea-rags-mcp-jgb5a).
      const hierarchy = hierarchyOf(parts);
      const head = parts[0].content.split("\n")[hierarchy.length];
      let symbol: NativeNode | undefined;
      walk(root, (n) => {
        if (n === root || n.startPosition.row !== firstRow || lastRowOf(n) !== lastRow) return;
        if (!fixture.code.slice(n.startIndex).startsWith(head)) return;
        if (!symbol || n.endIndex - n.startIndex > symbol.endIndex - symbol.startIndex) symbol = n;
      });
      expect(symbol).toBeDefined();
      expect(payload.content).toBe([...hierarchy, symbol?.text].join("\n"));
    });
  });
});
