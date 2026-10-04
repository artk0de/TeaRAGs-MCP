/**
 * Test outline by example for JavaScript Vitest/Jest/Mocha specs
 * (bd tea-rags-mcp-dppnr, epic tea-rags-mcp-phftd). The JavaScript scope
 * chunker reads the AST into the neutral `TestScope` tree and the kernel emits
 * one chunk per example, so every `it` / `test` is addressable by
 * `find_symbol` and a scope id outlines its examples.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { beforeAll, describe, expect, it } from "vitest";

import { memberSetupText, setupChainOf } from "../../__helpers__/setup-chain.js";
import type { BodyChunkResult } from "../../../../../../src/core/contracts/types/chunker.js";
import { resolveSymbols } from "../../../../../../src/core/domains/explore/symbol-resolve.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { jsTestDslFilterHook } from "../../../../../../src/core/domains/language/javascript/chunking/test-dsl-filter.js";
import {
  isDslContainerCall,
  jsTestScopeChunkerHook,
} from "../../../../../../src/core/domains/language/javascript/chunking/test-scope-chunker.js";

let jsParser: Parser;

beforeAll(() => {
  jsParser = new Parser();
  jsParser.setLanguage(JsLang);
});

function topLevelCall(code: string): Parser.SyntaxNode {
  const stmt = jsParser.parse(code).rootNode.namedChildren.find((c) => c.type === "expression_statement");
  const call = stmt?.namedChildren.find((c) => c.type === "call_expression");
  if (!call) throw new Error("no top-level call_expression");
  return call;
}

function runHook(code: string, maxChunkSize = 5000): BodyChunkResult[] {
  const ctx = {
    containerNode: topLevelCall(code),
    validChildren: [],
    code,
    codeLines: code.split("\n"),
    config: { maxChunkSize },
    filePath: "test/cart.test.js",
    excludedRows: new Set<number>(),
    methodPrefixes: new Map<number, string>(),
    methodStartLines: new Map<number, number>(),
    bodyChunks: [] as BodyChunkResult[],
    skipChildren: false,
  };
  jsTestScopeChunkerHook.process(ctx as never);
  return ctx.bodyChunks;
}

/** Every id the chunks answer find_symbol for: a pack's members, else the chunk's own id (bd tea-rags-mcp-g5i0a). */
function addresses(chunks: BodyChunkResult[]): (string | undefined)[] {
  return chunks.flatMap((c) => c.memberSymbolIds ?? [c.symbolId]);
}

const body = (label: string): string =>
  `    const result = computeTheExpectedValueFor('${label}');\n    expect(result).toEqual(expected['${label}']);`;

describe("JavaScript test outline by example (bd tea-rags-mcp-dppnr)", () => {
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

    // INVARIANT CHANGED (bd tea-rags-mcp-g5i0a): the two adjacent examples
    // share one pack; each is addressed by its member id and own line range.
    expect(addresses(chunks)).toEqual([
      "Cart.describe 'Cart'.it 'adds an item'",
      "Cart.describe 'Cart'.it 'removes an item'",
    ]);
    for (const chunk of chunks) {
      expect(chunk.chunkType).toBe("test");
      expect(chunk.parentSymbolId).toBe("Cart.describe 'Cart'");
      expect(chunk.parentType).toBe("test_scope");
    }
    expect(chunks[0].lineRanges).toEqual([
      { start: 2, end: 5 },
      { start: 7, end: 10 },
    ]);
  });

  it("keeps .skip / .only / .todo / .concurrent visible in scope and example names", () => {
    const code = `describe('Cart', function () {
  context.only('focused checkout flow', function () {
    it.skip('applies a coupon', function () {
${body("coupon")}
    });

    it.only('charges the card', async function () {
${body("charge")}
    });

    test.concurrent('ships the parcel', async () => {
${body("ship")}
    });

    it.todo('refunds a cancelled order after the carrier confirms the return');
  });
});`;

    const scopeId = "Cart.context.only 'focused checkout flow'";

    expect(addresses(runHook(code))).toEqual([
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

    // INVARIANT CHANGED (bd tea-rags-mcp-g5i0a): both examples share one pack.
    expect(addresses(chunks)).toEqual([
      "Cart.describe 'Cart'.it.each 'sums %i and %i into the running total'",
      "Cart.describe 'Cart'.it 'keeps the running total at zero when empty'",
    ]);
    expect(chunks[0].memberRowCounts).toEqual([4, 4]);
  });

  it("claims a top-level describe.each(table)(name, fn) container and names it with .each", () => {
    const code = `describe.each([['usd'], ['eur']])('Cart in %s', (currency) => {
  it('formats the grand total in the currency', () => {
${body("format")}
  });
});`;
    const call = topLevelCall(code);

    expect(jsTestDslFilterHook.filterNode!(call, code, "test/cart.test.js")).toBe(true);
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

    expect(addresses(runHook(code))).toEqual([
      "Cart.describe 'Cart'.it 'recalculates the total'",
      "Cart.describe 'Cart'.it 'recalculates the total'~2",
    ]);
  });

  // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): hooks were prefixed into every
  // example; each scope's hooks are now ONE setup chunk the example references.
  it("references every ancestor's hooks and the scope's own as setup chunks, line range the example's own", () => {
    const code = `describe('Cart', () => {
  beforeEach(() => { signIn(customer); });

  describe('with a coupon', () => {
    beforeEach(() => { cart.apply(coupon); });

    it('discounts the subtotal', () => {
${body("discount")}
    });
  });
});`;

    const chunks = runHook(code);
    const chunk = chunks.find((c) => c.parentType === "test_scope")!;

    expect(chunk.symbolId).toBe("Cart.describe 'with a coupon'.it 'discounts the subtotal'");
    expect(setupChainOf(chunks, chunk)).toEqual(["Cart.describe 'Cart'", "Cart.describe 'with a coupon'"]);
    expect(chunk.content).not.toContain("signIn(customer)");
    expect(memberSetupText(chunks, "Cart.describe 'Cart'")).toContain("signIn(customer)");
    expect(memberSetupText(chunks, "Cart.describe 'with a coupon'")).toContain("cart.apply(coupon)");
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

  describe("through the real chunker and find_symbol", () => {
    const relativePath = "test/cart.test.js";
    const assertions = Array.from(
      { length: 30 },
      (_, i) => `    expect(cart.lineItem(${i}).total).toEqual(expectedTotals[${i}]);`,
    ).join("\n");
    const source = `describe('Cart', () => {
  beforeEach(() => { cart = buildCartWithManyLineItems(); });

  it('totals every line item it holds', () => {
${assertions}
  });

  it('starts empty before anything is added', () => {
${body("empty")}
  });
});
`;

    async function payloads() {
      const chunker = new TreeSitterChunker(
        { chunkSize: 600, chunkOverlap: 0, maxChunkSize: 600 },
        new DefaultSymbolIdComposer(),
        new LanguageFactory(),
      );
      const chunks = await chunker.chunk(source, relativePath, "javascript");
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
            language: "javascript",
            startLine: c.startLine,
            endLine: c.endLine,
            content: c.content,
          },
        }))
        .reverse();
    }

    const scopeId = "Cart.describe 'Cart'";
    const bigId = `${scopeId}.it 'totals every line item it holds'`;

    it("find_symbol on an oversized example stitches its #partN parts back into the whole example", async () => {
      const all = await payloads();
      expect(all.some((p) => p.payload.symbolId === `${bigId}#part1`)).toBe(true);

      const [hit] = resolveSymbols(all, bigId);

      expect(hit.payload?.symbolId).toBe(bigId);
      expect(hit.payload?.content).toContain("it('totals every line item it holds'");
      expect(hit.payload?.content).toContain("expectedTotals[0]");
      expect(hit.payload?.content).toContain("expectedTotals[29]");
    });

    it("find_symbol on the scope outlines each example once, by name", async () => {
      const [outline] = resolveSymbols(await payloads(), scopeId);

      expect(outline.payload?.content).toBe(
        [scopeId, `  ${bigId}`, `  ${scopeId}.it 'starts empty before anything is added'`].join("\n"),
      );
    });
  });
});
