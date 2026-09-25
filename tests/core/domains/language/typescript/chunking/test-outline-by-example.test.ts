/**
 * Test outline by example for Vitest/Jest specs (bd tea-rags-mcp-b55x2, epic
 * tea-rags-mcp-phftd). The TypeScript scope chunker reads the AST into the
 * neutral `TestScope` tree and the kernel emits one chunk per example, so every
 * `it` / `test` is addressable by `find_symbol` and a scope id outlines its
 * examples.
 *
 * Reproducer from the epic: `tests/core/domains/explore/strategies/file-outline.test.ts`
 * outlined as `FileOutlineStrategy.describe "FileOutlineStrategy"#part1..#part4`
 * with no `it` names.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import Parser from "tree-sitter";
import { beforeAll, describe, expect, it } from "vitest";

import type { BodyChunkResult } from "../../../../../../src/core/contracts/types/chunker.js";
import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { testDslFilterHook } from "../../../../../../src/core/domains/language/typescript/chunking/test-dsl-filter.js";
import {
  isDslContainerCall,
  testScopeChunkerHook,
} from "../../../../../../src/core/domains/language/typescript/chunking/test-scope-chunker.js";

let tsLang: unknown;

beforeAll(async () => {
  const tsModule = await import("tree-sitter-typescript");
  tsLang =
    (tsModule.default as { typescript?: unknown })?.typescript ?? (tsModule as { typescript?: unknown }).typescript;
});

function parseTs(code: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(tsLang as Parser.Language);
  return parser.parse(code);
}

function topLevelCall(tree: Parser.Tree): Parser.SyntaxNode {
  const stmt = tree.rootNode.namedChildren.find((c) => c.type === "expression_statement");
  const call = stmt?.namedChildren.find((c) => c.type === "call_expression");
  if (!call) throw new Error("no top-level call_expression");
  return call;
}

function runHook(code: string, maxChunkSize = 5000): BodyChunkResult[] {
  const ctx = {
    containerNode: topLevelCall(parseTs(code)),
    validChildren: [],
    code,
    codeLines: code.split("\n"),
    config: { maxChunkSize },
    filePath: "tests/cart.test.ts",
    excludedRows: new Set<number>(),
    methodPrefixes: new Map<number, string>(),
    methodStartLines: new Map<number, number>(),
    bodyChunks: [] as BodyChunkResult[],
    skipChildren: false,
  };
  testScopeChunkerHook.process(ctx as never);
  return ctx.bodyChunks;
}

const body = (label: string): string =>
  `    const result = computeTheExpectedValueFor('${label}');\n    expect(result).toEqual(expected['${label}']);`;

describe("TypeScript test outline by example (bd tea-rags-mcp-b55x2)", () => {
  it("emits one test chunk per example, addressed <top>.<scope>.<example>, parented by the scope", () => {
    const code = `describe('Cart', () => {
  it('adds an item', () => {
${body("add")}
  });

  it('removes an item', () => {
${body("remove")}
  });
});`;

    const chunks = runHook(code);

    expect(chunks.map((c) => c.symbolId)).toEqual([
      "Cart.describe 'Cart'.it 'adds an item'",
      "Cart.describe 'Cart'.it 'removes an item'",
    ]);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.parentSymbolId).toBe("Cart.describe 'Cart'");
      expect(chunk.parentType).toBe("test_scope");
    }
    expect(chunks[0].name).toBe("it 'adds an item'");
    expect(chunks[0].content).not.toContain("removes an item");
    expect([chunks[0].startLine, chunks[0].endLine]).toEqual([2, 5]);
  });

  it("keeps .skip / .only / .todo / .concurrent visible in scope and example names", () => {
    const code = `describe('Cart', () => {
  describe.only('focused checkout flow', () => {
    it.skip('applies a coupon', () => {
${body("coupon")}
    });

    it.only('charges the card', () => {
${body("charge")}
    });

    test.concurrent('ships the parcel', async () => {
${body("ship")}
    });

    it.todo('refunds a cancelled order after the carrier confirms the return');
  });
});`;

    const chunks = runHook(code);
    const scopeId = "Cart.describe.only 'focused checkout flow'";

    expect(chunks.map((c) => c.symbolId)).toEqual([
      `${scopeId}.it.skip 'applies a coupon'`,
      `${scopeId}.it.only 'charges the card'`,
      `${scopeId}.test.concurrent 'ships the parcel'`,
      `${scopeId}.it.todo 'refunds a cancelled order after the carrier confirms the return'`,
    ]);
  });

  it("reads a parametrized it.each(table)(name, fn) as ONE example named with .each, not as scope context", () => {
    const code = `describe('Cart', () => {
  it.each([[1, 2], [3, 4]])('sums %i and %i into the running total', (a, b) => {
${body("sum")}
  });

  it('keeps the running total at zero when empty', () => {
${body("empty")}
  });
});`;

    const chunks = runHook(code);

    expect(chunks.map((c) => c.name)).toEqual([
      "it.each 'sums %i and %i into the running total'",
      "it 'keeps the running total at zero when empty'",
    ]);
    // The parametrized example is an example, so its text never leaks into a
    // sibling example as scope context.
    expect(chunks[1].content).not.toContain("it.each");
  });

  it("claims a top-level describe.each(table)(name, fn) container and names it with .each", () => {
    const code = `describe.each([['usd'], ['eur']])('Cart in %s', (currency) => {
  it('formats the grand total in the currency', () => {
${body("format")}
  });
});`;
    const call = topLevelCall(parseTs(code));

    expect(testDslFilterHook.filterNode!(call, code, "tests/cart.test.ts")).toBe(true);
    expect(isDslContainerCall(call, code)).toBe(true);
    expect(runHook(code).map((c) => c.symbolId)).toEqual([
      "Cart in %s.describe.each 'Cart in %s'.it 'formats the grand total in the currency'",
    ]);
  });

  it("gives repeated example ids ~N in source order", () => {
    const code = `describe('Cart', () => {
  it('recalculates the total', () => {
${body("first")}
  });

  it('recalculates the total', () => {
${body("second")}
  });
});`;

    expect(runHook(code).map((c) => c.symbolId)).toEqual([
      "Cart.describe 'Cart'.it 'recalculates the total'",
      "Cart.describe 'Cart'.it 'recalculates the total'~2",
    ]);
  });

  it("prefixes every ancestor's hooks and the scope's own before each example, line range the example's own", () => {
    const code = `describe('Cart', () => {
  beforeEach(() => { signIn(customer); });

  describe('with a coupon', () => {
    beforeEach(() => { cart.apply(coupon); });

    it('discounts the subtotal', () => {
${body("discount")}
    });
  });
});`;

    const [chunk] = runHook(code);

    expect(chunk.symbolId).toBe("Cart.describe 'with a coupon'.it 'discounts the subtotal'");
    expect(chunk.content.indexOf("signIn(customer)")).toBeLessThan(chunk.content.indexOf("cart.apply(coupon)"));
    expect(chunk.content.indexOf("cart.apply(coupon)")).toBeLessThan(chunk.content.indexOf("discounts the subtotal"));
    expect([chunk.startLine, chunk.endLine]).toEqual([7, 10]);
  });

  it("names a callback-only describe by its call alone, never by the callback text", () => {
    const code = `describe(() => {
  it('runs anonymously with the full assertion coverage', () => {
${body("anon")}
  });
});`;

    expect(runHook(code).map((c) => c.symbolId)).toEqual([
      "describe.describe.it 'runs anonymously with the full assertion coverage'",
    ]);
  });

  describe("reproducer: tests/core/domains/explore/strategies/file-outline.test.ts", () => {
    const relativePath = "tests/core/domains/explore/strategies/file-outline.test.ts";
    const source = readFileSync(resolve(process.cwd(), relativePath), "utf-8");
    const rootScopeId = 'FileOutlineStrategy.describe "FileOutlineStrategy"';

    async function payloads() {
      const chunker = new TreeSitterChunker(
        { chunkSize: 2500, chunkOverlap: 0, maxChunkSize: 5000 },
        new DefaultSymbolIdComposer(),
        new LanguageFactory(),
      );
      const chunks = await chunker.chunk(source, relativePath, "typescript");
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
            relativePath,
            language: "typescript",
            startLine: c.startLine,
            endLine: c.endLine,
            content: c.content,
          },
        }));
    }

    it("addresses every it of the file as its own example, none twice", async () => {
      const itCount = source.split("\n").filter((line) => /^\s*it\(/.test(line)).length;
      const examples = (await payloads()).filter((p) => p.payload.parentType === "test_scope");
      const baseIds = examples.map((p) => p.payload.symbolId!.replace(/#part\d+$/, ""));
      const wholeIds = examples.map((p) => p.payload.symbolId).filter((id) => !/#part\d+$/.test(id!));

      expect(new Set(baseIds).size).toBe(itCount);
      expect(new Set(wholeIds).size).toBe(wholeIds.length);
      for (const id of baseIds) expect(id).toMatch(/\.it "[^"]+"$/);
    });

    it("find_symbol on the root scope outlines its examples by name", async () => {
      const [outline] = resolveSymbols(await payloads(), rootScopeId);

      expect(outline.payload?.content).toContain(
        `${rootScopeId}.it "scrolls by relativePath filter at a fixed page size"`,
      );
      expect(outline.payload?.content).not.toMatch(/#part\d+/);
    });
  });
});
