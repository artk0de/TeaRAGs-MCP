/**
 * Nested-member RECALL guard — a callable declared inside a container the
 * chunker already claimed must still get a chunk of its own.
 *
 * `symbolid-lockstep.test.ts` pins that the two producers NAME a node the same
 * way. It cannot see the failure this file pins, because its assertion loops
 * over the chunks that exist:
 *
 *     for (const id of chunkerIds) expect(graphIds).toContain(id);
 *
 * Emit nothing and the loop body never runs — the guard goes green on an empty
 * set. bd tea-rags-mcp-ll0u9 was exactly that: for JavaScript the chunker
 * emitted no chunk at all for an object-literal member nested in a function
 * body, so `cg_symbols` carried `register.handle` while no Qdrant chunk backed
 * it. `get_callers` resolved the id, `find_symbol` returned empty.
 *
 * The asymmetry is the tell and the assertion: the IDENTICAL source, chunked as
 * TypeScript, emitted the member. Only JavaScript under-emitted — it declared
 * neither `childChunkTypes` nor `alwaysExtractChildren`, so the engine never
 * descended into a container it had already claimed. Every source below is
 * valid in BOTH languages, so parity is a real invariant and not a coincidence
 * of two grammars.
 *
 * bd tea-rags-mcp-ll0u9.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { jsNameOf } from "../../../../../../src/core/domains/language/javascript/index.js";
import { javascriptKernel } from "../../../../../../src/core/domains/language/javascript/kernel.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

const composer = new DefaultSymbolIdComposer();
const languages = new LanguageFactory();

/**
 * An object literal passed straight as a call argument — the reproducer from
 * the bead. It declares no namespace of its own, so both sides scope `handle`
 * under the enclosing function.
 */
const CALL_ARGUMENT_OBJECT = [
  "function register() {",
  "  install({",
  "    handle(event) {",
  "      const trimmed = event.trim();",
  "      return trimmed.toUpperCase();",
  "    },",
  "  });",
  "}",
].join("\n");

/** Same member, reached through a declarator instead of an argument position. */
const DECLARATOR_OBJECT = [
  "function register() {",
  "  const spec = {",
  "    handle(event) {",
  "      const trimmed = event.trim();",
  "      return trimmed.toUpperCase();",
  "    },",
  "  };",
  "  install(spec);",
  "}",
].join("\n");

/**
 * Not from the bead's reproducer, but the same descent gap: `method_definition`
 * is a JavaScript chunkable type, yet `findChunkableNodes` stops at the
 * enclosing `class_declaration`, so the methods were never reached either.
 */
const CLASS_WITH_BOTH_METHOD_KINDS = [
  "class Registry {",
  "  register(handler) {",
  "    const seen = new Set();",
  "    seen.add(handler);",
  "    return [...seen];",
  "  }",
  "",
  "  static create() {",
  "    const instance = new Registry();",
  "    return instance;",
  "  }",
  "}",
].join("\n");

/**
 * Each shape pairs with the member NAMES a chunk must exist for. Names, not
 * symbolIds: how the parent chain composes into an id is a separate invariant
 * (bd tea-rags-mcp-cv4k1), and this guard is about the chunk existing at all.
 */
/**
 * `export_statement` is a JavaScript chunkable type, so the engine claims it
 * INSTEAD of the `class_declaration` it wraps — and an `export_statement` has no
 * `name` field of its own. Descending into a container whose name did not
 * resolve would scope the method at file level (`register`) instead of under
 * its class (`Registry#register`), trading the missing chunk this bead is about
 * for a symbolId no `cg_symbols` row carries. TypeScript never hits this: it
 * keeps `export_statement` out of `chunkableTypes` entirely, so the walk
 * reaches the class itself.
 */
const EXPORTED_CLASS = [
  "export class Registry {",
  "  register(handler) {",
  "    const seen = new Set();",
  "    seen.add(handler);",
  "    return [...seen];",
  "  }",
  "}",
].join("\n");

const SHAPES: readonly (readonly [string, string, readonly string[]])[] = [
  ["object literal in a call argument", CALL_ARGUMENT_OBJECT, ["handle"]],
  ["object literal behind a declarator", DECLARATOR_OBJECT, ["handle"]],
  ["class with instance and static methods", CLASS_WITH_BOTH_METHOD_KINDS, ["register", "create"]],
  ["exported class", EXPORTED_CLASS, ["register"]],
];

describe("nested-member recall — chunks exist for callables inside a claimed container (bd tea-rags-mcp-ll0u9)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, composer, languages);
  });

  async function callableChunks(language: "javascript" | "typescript", src: string) {
    const extension = language === "javascript" ? "js" : "ts";
    const chunks = await chunker.chunk(src, `subject.${extension}`, language);
    return chunks.filter((c) => c.metadata.chunkType === "function");
  }

  async function callableIds(language: "javascript" | "typescript", src: string): Promise<string[]> {
    return (await callableChunks(language, src))
      .map((c) => c.metadata.symbolId)
      .filter((id): id is string => id !== undefined);
  }

  async function callableNames(language: "javascript" | "typescript", src: string): Promise<string[]> {
    return (await callableChunks(language, src))
      .map((c) => c.metadata.name)
      .filter((name): name is string => name !== undefined);
  }

  /** Ids the CODEGRAPH side persists into `cg_symbols` for this JavaScript source. */
  function javascriptCodegraphIds(src: string): string[] {
    const parser = new Parser();
    parser.setLanguage(JsLang as unknown as Parser.Language);
    const root = materializeTree(parser.parse(src).rootNode, src);
    return collectSymbols(
      { rootNode: root },
      jsNameOf,
      javascriptKernel.scopeSeparator ?? ".",
      javascriptKernel.disambiguateOverloads ?? false,
      composer,
    ).map((s) => s.symbolId);
  }

  it.each(SHAPES)("emits a JavaScript chunk for the nested member — %s", async (_shape, src, members) => {
    // The vacuity check the lockstep guard structurally cannot make: an EMPTY
    // set is the defect, and every "for each emitted id …" assertion passes on
    // it.
    const names = await callableNames("javascript", src);
    for (const member of members) expect(names).toContain(member);
  });

  it.each(SHAPES)("names the nested member identically in JavaScript and TypeScript — %s", async (_shape, src) => {
    // Every shape above is valid in both grammars, so a divergence here is a
    // chunker defect, never a language difference.
    expect(await callableIds("javascript", src)).toEqual(await callableIds("typescript", src));
  });

  it("backs the call-argument member with a chunk carrying the id cg_symbols holds", async () => {
    // The end-to-end symptom: `find_symbol("register.handle")` must not come
    // back empty while `get_callers("register.handle")` resolves.
    expect(javascriptCodegraphIds(CALL_ARGUMENT_OBJECT)).toContain("register.handle");
    expect(await callableIds("javascript", CALL_ARGUMENT_OBJECT)).toContain("register.handle");
  });

  it("emits both method kinds of a JavaScript class with the convention's separators", async () => {
    const ids = await callableIds("javascript", CLASS_WITH_BOTH_METHOD_KINDS);
    expect(ids).toContain("Registry#register");
    expect(ids).toContain("Registry.create");
  });

  it("scopes a method under its class even when the export wraps the declaration", async () => {
    // Guards the trade this fix must NOT make: descending into a container
    // whose name did not resolve would emit a bare `register`, an id no
    // cg_symbols row carries.
    const ids = await callableIds("javascript", EXPORTED_CLASS);
    expect(ids).toContain("Registry#register");
    expect(ids).not.toContain("register");
  });
});
