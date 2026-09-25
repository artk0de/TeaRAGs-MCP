/**
 * DSL-named calls that are not examples (bd tea-rags-mcp-c0vdv), driven
 * through the real `TreeSitterChunker`. Shape reduced from express's
 * `test/res.format.js`: a shared-behaviour helper `function test(app)` that
 * defines `it(...)` examples, called as `test(app)` from inside describes.
 *
 * Before the fix the helper CALL was filed as an example (`….test app`) and
 * each `it` inside the helper DEFINITION became a leaf chunk `test.it` — five
 * identical, title-less, unaddressable ids.
 */

import { describe, expect, it } from "vitest";

import type { CodeChunk } from "../../../../../../src/core/contracts/types/chunker.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";

const LANGUAGE = "javascript";
const RELATIVE_PATH = "test/res.format.js";

const expectBody = (label: string): string =>
  `    request(app)\n    .get('/')\n    .set('Accept', '${label}')\n    .expect(200, done);`;

const SOURCE = `describe('res', function(){
  describe('with parameters', function(){
    var app = express();

    app.use(function(req, res, next){
      res.format({ text: function(){ res.send('hey') } });
    });

    test(app);
  })

  describe('in router', function(){
    test(app4);
  })

  describe('in router', function(){
    var app = express();
    var router = express.Router();
    app.use(router)

    test(app)
  })

  describe('pending', function(){
    it.todo('should negotiate a charset from the Accept-Charset header')
  })
})

function test(app) {
  it('should utilize qvalues in negotiation', function(done){
${expectBody("text/html; q=.5, application/json")}
  })

  it('should allow wildcard type/subtypes', function(done){
${expectBody("text/html; q=.5, application/*")}
  })

  it('should Vary: Accept', function(done){
${expectBody("text/html; q=.5, text/plain")}
  })
}
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

describe("JavaScript DSL-named calls that are not examples (bd tea-rags-mcp-c0vdv)", () => {
  it("files a helper call with neither a title nor a callback as a statement, not an example", async () => {
    const chunks = await chunk(SOURCE);

    expect(ids(chunks).filter((id) => id.includes(".test app"))).toEqual([]);
    const withParameters = chunks.find((c) => c.metadata.symbolId === "res.describe 'with parameters'");
    expect(withParameters?.metadata.chunkType).toBe("test_setup");
    expect(withParameters?.content).toContain("test(app);");
  });

  it("keeps a title-only it.todo as an example", async () => {
    const chunks = await chunk(SOURCE);

    const todo = chunks.find(
      (c) =>
        c.metadata.symbolId ===
        "res.describe 'pending'.it.todo 'should negotiate a charset from the Accept-Charset header'",
    );
    expect(todo?.metadata.chunkType).toBe("test");
  });

  it("keeps a helper function that defines examples as one plain function chunk, examples included", async () => {
    const chunks = await chunk(SOURCE);

    expect(ids(chunks).filter((id) => /(^|\.)test\.it($|~)/.test(id))).toEqual([]);
    const helper = chunks.filter((c) => c.metadata.symbolId === "test");
    expect(helper).toHaveLength(1);
    expect(helper[0].content).toContain("it('should utilize qvalues in negotiation'");
    expect(helper[0].content).toContain("it('should Vary: Accept'");
  });

  it("never emits two chunks with one symbolId except the #partN windows of one symbol", async () => {
    const all = ids(await chunk(SOURCE)).filter((id) => !/#part\d+$/.test(id));

    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((id, i) => all.indexOf(id) !== i)).toEqual([]);
  });

  it("keeps a describe created inside a helper in the helper's chunk, with the helper's own statements", async () => {
    const chunks = await chunk(`function sharedNegotiation(app) {
  var negotiatedApplication = buildTheNegotiatingApplication(app);

  describe('when Accept is not present', function(){
    it('should invoke the first callback', function(done){
${expectBody("*/*")}
    })
  })
}
`);

    expect(ids(chunks)).toEqual(["sharedNegotiation"]);
    expect(chunks[0].content).toContain("var negotiatedApplication = buildTheNegotiatingApplication(app);");
    expect(chunks[0].content).toContain("it('should invoke the first callback'");
  });

  it("still discovers a describe created by a loop callback at top level", async () => {
    const chunks = await chunk(`['get', 'post'].forEach(function(method){
  describe('.' + method + '()', function(){
    it('should respond to the verb with the routed handler', function(done){
${expectBody("text/plain")}
    })
  })
})
`);

    expect(chunks.filter((c) => c.metadata.chunkType === "test")).toHaveLength(1);
  });

  it("still sees through a parametrizer to the example it names", async () => {
    const chunks = await chunk(`describe('Cart', () => {
  it.each(table)('adds %i items to the cart and totals them', (n, done) => {
${expectBody("application/json")}
  });
});
`);

    expect(ids(chunks)).toContain("Cart.describe 'Cart'.it.each 'adds %i items to the cart and totals them'");
  });
});
