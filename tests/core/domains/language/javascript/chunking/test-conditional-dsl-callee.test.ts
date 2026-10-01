/**
 * A DSL call whose callee is a parenthesized conditional (bd tea-rags-mcp-rvuun),
 * driven through the real `TreeSitterChunker`. Shape reduced from express's
 * `test/express.static.js`: `(skipRelative ? describe.skip : describe)('current
 * dir', function () { … })` inside a describe that has only child scopes.
 *
 * Before the fix the conditional callee was not DSL, so the block became an
 * `otherLines` statement of a scope with no examples of its own — its setup and
 * its `it` reached no chunk at all.
 */

import { describe, expect, it } from "vitest";

import type { CodeChunk } from "../../../../../../src/core/contracts/types/chunker.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

const LANGUAGE = "javascript";
const RELATIVE_PATH = "test/express.static.js";

const requestBody = (path: string): string =>
  `      request(this.app)\n        .get('${path}')\n        .expect(200, '- groceries', done)`;

const SOURCE = `describe('express.static()', function () {
  describe('basic operations', function () {
    it('should serve static files', function (done) {
${requestBody("/todo.txt")}
    })
  });

  (skipRelative ? describe.skip : describe)('current dir', function () {
    before(function () {
      this.app = createApp('.')
    })

    it('should be served with "."', function (done) {
      var dest = relative.split(path.sep).join('/')
${requestBody("/' + dest + '/todo.txt")}
    })
  })
})
`;

async function chunk(source: string): Promise<CodeChunk[]> {
  const chunker = new TreeSitterChunker(
    { chunkSize: 2500, chunkOverlap: 0, maxChunkSize: 5000 },
    new DefaultSymbolIdComposer(),
    new LanguageFactory(),
  );
  return chunker.chunk(source, RELATIVE_PATH, LANGUAGE);
}

const ids = (chunks: CodeChunk[]): string[] =>
  chunks.map((c) => c.metadata.symbolId).filter((id): id is string => id !== undefined);

const CURRENT_DIR = "express.static().(skipRelative ? describe.skip : describe) 'current dir'";

describe("JavaScript DSL call with a conditional callee (bd tea-rags-mcp-rvuun)", () => {
  it("reads a conditional whose arms name one DSL word as that DSL call, named by the call as written", async () => {
    const chunks = await chunk(SOURCE);

    const example = chunks.find((c) => c.metadata.symbolId === `${CURRENT_DIR}.it 'should be served with "."'`);
    expect(example?.metadata.chunkType).toBe("test");
    expect(example?.metadata.parentSymbolId).toBe(CURRENT_DIR);
    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the scope's hook is its own
    // setup chunk under the scope id, referenced by the example.
    expect(example?.metadata.setupScopeIds).toEqual([CURRENT_DIR]);
    expect(chunks.find((c) => c.metadata.symbolId === CURRENT_DIR)?.content).toContain("this.app = createApp('.')");
    expect(example?.content).toContain("var dest = relative.split(path.sep).join('/')");
  });

  it("names the conditional canonically however its source is laid out", async () => {
    const chunks = await chunk(
      SOURCE.replace(
        "(skipRelative ? describe.skip : describe)",
        "(\n    skipRelative\n      ?   describe . skip\n      : describe\n  )",
      ),
    );

    expect(ids(chunks)).toContain(`${CURRENT_DIR}.it 'should be served with "."'`);
  });

  it("claims a top-level conditional container and names the file's root by its title", async () => {
    const chunks = await chunk(`(onCi ? describe.skip : describe)('Cart', () => {
  it('totals every line item the cart holds', () => {
    expect(new Cart([1, 2, 3]).total()).toBe(6);
  });
});
`);

    expect(ids(chunks)).toEqual([
      "Cart.(onCi ? describe.skip : describe) 'Cart'.it 'totals every line item the cart holds'",
    ]);
  });

  it("reads a conditional example callee as an example", async () => {
    const chunks = await chunk(`describe('Cart', () => {
  (onCi ? it.skip : it)('totals every line item the cart holds', () => {
    expect(new Cart([1, 2, 3]).total()).toBe(6);
  });
});
`);

    expect(ids(chunks)).toEqual(["Cart.describe 'Cart'.(onCi ? it.skip : it) 'totals every line item the cart holds'"]);
  });

  it("keeps a conditional whose arms name different DSL words, or a non-DSL callee, non-DSL", async () => {
    const chunks = await chunk(`describe('Cart', () => {
  (onCi ? describe : it)('mixes a container and an example word', () => {
    it('is never read as an example of a mixed conditional', () => {});
  });

  (onCi ? runSuite : describe)('names a helper in one arm', () => {
    it('is never read as an example of a helper conditional', () => {});
  });

  it('totals every line item the cart holds', () => {
    expect(new Cart([1, 2, 3]).total()).toBe(6);
  });
});
`);

    expect(ids(chunks).filter((id) => id.includes("?"))).toEqual([]);
    const example = chunks.find(
      (c) => c.metadata.symbolId === "Cart.describe 'Cart'.it 'totals every line item the cart holds'",
    );
    // INVARIANT CHANGED (bd tea-rags-mcp-5xpq4): the non-DSL statements are the
    // root scope's own lines — its setup chunk, which the example references.
    expect(example?.metadata.setupScopeIds).toEqual(["Cart.describe 'Cart'"]);
    const rootSetup = chunks.find((c) => c.metadata.symbolId === "Cart.describe 'Cart'");
    expect(rootSetup?.content).toContain("(onCi ? describe : it)('mixes a container and an example word'");
    expect(rootSetup?.content).toContain("(onCi ? runSuite : describe)('names a helper in one arm'");
  });

  it("never emits two chunks with one symbolId except the #partN windows of one symbol", async () => {
    const all = ids(await chunk(SOURCE)).filter((id) => !/#part\d+$/.test(id));

    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((id, i) => all.indexOf(id) !== i)).toEqual([]);
  });
});
