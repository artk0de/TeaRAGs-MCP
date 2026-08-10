/**
 * symbolId LOCKSTEP guard — the chunker (Qdrant payload `symbolId`) and the
 * codegraph symbol collector (`cg_symbols.symbol_id`) must name the same
 * physical AST node identically. `.claude/rules/symbolid-convention.md` states
 * the invariant; this file is what fails when the two sides drift.
 *
 * The two producers are structurally independent — the chunker composes ids from
 * `chunkableTypes` / `childChunkTypes` / hooks, while the codegraph composes them
 * from the language's `nameOf` — so a fix applied to one side alone (as in bd
 * tea-rags-mcp-2jhwk, which taught only the walker about const-object
 * namespaces) leaves `get_callers(symbolId)` looking up an id no chunk carries.
 * Running both over the same source is the only thing that catches that.
 *
 * bd tea-rags-mcp-62hzr.
 */

import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import TsLang from "tree-sitter-typescript";
import { beforeEach, describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import type { NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageKernel } from "../../../../../../src/core/contracts/types/language.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import { jsNameOf } from "../../../../../../src/core/domains/language/javascript/index.js";
import { javascriptKernel } from "../../../../../../src/core/domains/language/javascript/kernel.js";
import { collectSymbols } from "../../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { tsNameOf } from "../../../../../../src/core/domains/language/typescript/index.js";
import { typescriptKernel } from "../../../../../../src/core/domains/language/typescript/kernel.js";
import { materializeTree } from "../../../../../../src/core/infra/materialize.js";
import type { ChunkerConfig } from "../../../../../../src/core/types.js";

const composer = new DefaultSymbolIdComposer();
const languages = new LanguageFactory();

interface LockstepLanguage {
  /** Chunker-side language name + file extension. */
  language: string;
  extension: string;
  grammar: Parser.Language;
  kernel: LanguageKernel;
  nameOf: (node: AstNode) => NamedSymbol | NamedSymbol[] | null;
}

const TYPESCRIPT: LockstepLanguage = {
  language: "typescript",
  extension: "ts",
  grammar: TsLang.typescript as unknown as Parser.Language,
  kernel: typescriptKernel,
  nameOf: tsNameOf,
};

const JAVASCRIPT: LockstepLanguage = {
  language: "javascript",
  extension: "js",
  grammar: JsLang as unknown as Parser.Language,
  kernel: javascriptKernel,
  nameOf: jsNameOf,
};

/** Ids the CODEGRAPH side persists into `cg_symbols` for this source. */
function codegraphIds(lang: LockstepLanguage, src: string): string[] {
  const parser = new Parser();
  parser.setLanguage(lang.grammar);
  const root = materializeTree(parser.parse(src).rootNode, src);
  return collectSymbols(
    { rootNode: root },
    lang.nameOf,
    lang.kernel.scopeSeparator ?? ".",
    lang.kernel.disambiguateOverloads ?? false,
    composer,
  ).map((s) => s.symbolId);
}

describe("symbolId lockstep — chunker payload vs cg_symbols (bd tea-rags-mcp-62hzr)", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
    chunker = new TreeSitterChunker(config, composer, languages);
  });

  /** Ids the CHUNKER writes into the Qdrant payload for callable chunks. */
  async function chunkerCallableIds(lang: LockstepLanguage, src: string): Promise<string[]> {
    const chunks = await chunker.chunk(src, `subject.${lang.extension}`, lang.language);
    return chunks
      .filter((c) => c.metadata.chunkType === "function")
      .map((c) => c.metadata.symbolId)
      .filter((id): id is string => id !== undefined);
  }

  /**
   * The const-object namespace from the bead — `FileLevelGrouper.group` in
   * `domains/explore/chunk-grouping/file-level.ts`, reduced to its shape. The
   * body is padded past the chunker's 50-character floor so the member is
   * emitted as a chunk at all.
   */
  const CONST_OBJECT_NAMESPACE = [
    "export const FileLevelGrouper = {",
    "  group(results: string[], limit: number): string[] {",
    "    const seen = new Set<string>();",
    "    for (const result of results) seen.add(result);",
    "    return [...seen].slice(0, limit);",
    "  },",
    "};",
  ].join("\n");

  const CLASS_WITH_BOTH_METHOD_KINDS = [
    "export class ChunkGrouper {",
    "  group(results: string[]): string[] {",
    "    const seen = new Set<string>();",
    "    for (const result of results) seen.add(result);",
    "    return [...seen];",
    "  }",
    "",
    "  static create(): ChunkGrouper {",
    "    const instance = new ChunkGrouper();",
    "    return instance;",
    "  }",
    "}",
  ].join("\n");

  const TOP_LEVEL_FUNCTION = [
    "export function groupResults(results: string[]): string[] {",
    "  const seen = new Set<string>();",
    "  for (const result of results) seen.add(result);",
    "  return [...seen];",
    "}",
  ].join("\n");

  const CALL_ARGUMENT_OBJECT = [
    "export function register(): void {",
    "  install({",
    "    handle(event: string): string {",
    "      const trimmed = event.trim();",
    "      return trimmed.toUpperCase();",
    "    },",
    "  });",
    "}",
  ].join("\n");

  describe("TypeScript", () => {
    it("names a const-object namespace member the same on both sides", async () => {
      // The defect: cg_symbols held `FileLevelGrouper.group` while the payload
      // held a bare `group`, so `get_callers("FileLevelGrouper.group")` — the id
      // a user copies out of a search hit — matched no graph row.
      expect(await chunkerCallableIds(TYPESCRIPT, CONST_OBJECT_NAMESPACE)).toEqual(["FileLevelGrouper.group"]);
      expect(codegraphIds(TYPESCRIPT, CONST_OBJECT_NAMESPACE)).toContain("FileLevelGrouper.group");
    });

    it("scopes the namespace member under its declarator, not at file level", async () => {
      const chunks = await chunker.chunk(CONST_OBJECT_NAMESPACE, "subject.ts", "typescript");
      const member = chunks.find((c) => c.metadata.name === "group");
      expect(member?.metadata.parentSymbolId).toBe("FileLevelGrouper");
    });

    it("keeps the instance `#` for a class method and `.` for a static one", async () => {
      const ids = await chunkerCallableIds(TYPESCRIPT, CLASS_WITH_BOTH_METHOD_KINDS);
      expect(ids).toContain("ChunkGrouper#group");
      expect(ids).toContain("ChunkGrouper.create");
    });

    it("leaves a top-level function unscoped", async () => {
      expect(await chunkerCallableIds(TYPESCRIPT, TOP_LEVEL_FUNCTION)).toEqual(["groupResults"]);
    });

    // KNOWN GAP — bd tea-rags-mcp-pdv8m. `install({ handle() {} })` declares no
    // namespace of its own, so both sides scope the member under the enclosing
    // function; the member still binds no instance, and cg_symbols holds
    // `register.handle`. The chunker writes `register#handle` — an id nothing
    // resolves — because `buildSymbolId` takes a BOOLEAN isStatic and collapses
    // the namespace classification into "instance". bd 62hzr fixed the
    // declarator shape upstream instead of widening that composer.
    //
    // `it.fails` keeps the reproducer in the suite: when pdv8m lands these turn
    // into unexpected passes, which is the signal to flip them back to `it`.
    it.fails("joins an object literal in a call argument with the namespace separator, never `#`", async () => {
      const ids = await chunkerCallableIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT);
      expect(ids).toContain("register.handle");
      expect(ids).not.toContain("register#handle");
    });

    it.fails("emits no callable id absent from cg_symbols — object literal in a call argument", async () => {
      const graphIds = new Set(codegraphIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT));
      for (const id of await chunkerCallableIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT)) {
        expect([...graphIds]).toContain(id);
      }
    });

    it.each([
      ["const-object namespace", CONST_OBJECT_NAMESPACE],
      ["class with instance and static methods", CLASS_WITH_BOTH_METHOD_KINDS],
      ["top-level function", TOP_LEVEL_FUNCTION],
    ])("emits no callable id absent from cg_symbols — %s", async (_shape, src) => {
      const graphIds = new Set(codegraphIds(TYPESCRIPT, src));
      for (const id of await chunkerCallableIds(TYPESCRIPT, src)) {
        expect([...graphIds]).toContain(id);
      }
    });
  });

  describe("JavaScript", () => {
    // JavaScript shares `method_definition` and delegates `jsNameOf` to
    // `tsNameOf`, so the const-object namespace reaches cg_symbols there too.
    //
    // Declared WITHOUT `export`: `export_statement` is a JavaScript chunkable
    // type and the walk never descends into one, so every exported declaration
    // — class, function, arrow, namespace alike — currently collapses into a
    // single nameless block chunk carrying no symbolId at all. That is a
    // separate defect with its own root cause and its own reindex-gated blast
    // radius (bd tea-rags-mcp-8mrfj); it is not what this guard is pinning.
    const JS_CONST_OBJECT_NAMESPACE = [
      "const FileLevelGrouper = {",
      "  group(results, limit) {",
      "    const seen = new Set();",
      "    for (const result of results) seen.add(result);",
      "    return [...seen].slice(0, limit);",
      "  },",
      "};",
    ].join("\n");

    it("names a const-object namespace member the same on both sides", async () => {
      expect(await chunkerCallableIds(JAVASCRIPT, JS_CONST_OBJECT_NAMESPACE)).toEqual(["FileLevelGrouper.group"]);
      expect(codegraphIds(JAVASCRIPT, JS_CONST_OBJECT_NAMESPACE)).toContain("FileLevelGrouper.group");
    });

    it("emits no callable id absent from cg_symbols", async () => {
      const graphIds = new Set(codegraphIds(JAVASCRIPT, JS_CONST_OBJECT_NAMESPACE));
      for (const id of await chunkerCallableIds(JAVASCRIPT, JS_CONST_OBJECT_NAMESPACE)) {
        expect([...graphIds]).toContain(id);
      }
    });
  });
});
