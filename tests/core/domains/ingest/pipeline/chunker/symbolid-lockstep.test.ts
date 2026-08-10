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

  /** Same shape, but the enclosing scope is an INSTANCE METHOD rather than a function. */
  const CALL_ARGUMENT_OBJECT_IN_METHOD = [
    "export class Registry {",
    "  register(): void {",
    "    install({",
    "      handle(event: string): string {",
    "        const trimmed = event.trim();",
    "        return trimmed.toUpperCase();",
    "      },",
    "    });",
    "  }",
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

    // FIXED by bd tea-rags-mcp-pdv8m. `install({ handle() {} })` declares no
    // namespace of its own, so both sides scope the member under the enclosing
    // function; the member still binds no instance, and cg_symbols holds
    // `register.handle`. The chunker used to write `register#handle` — an id
    // nothing resolves — because `buildSymbolId` took a BOOLEAN isStatic and
    // collapsed `classifyMethod`'s namespace classification into "instance".
    // bd 62hzr had fixed only the sibling DECLARATOR shape upstream
    // (`const X = { m() {} }`) instead of widening that composer, so this
    // non-declarator shape stayed broken until the composer took the tri-state.
    it("joins an object literal in a call argument with the namespace separator, never `#`", async () => {
      const ids = await chunkerCallableIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT);
      expect(ids).toContain("register.handle");
      expect(ids).not.toContain("register#handle");
    });

    it("emits no callable id absent from cg_symbols — object literal in a call argument", async () => {
      const graphIds = new Set(codegraphIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT));
      for (const id of await chunkerCallableIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT)) {
        expect([...graphIds]).toContain(id);
      }
    });

    // FIXED by bd tea-rags-mcp-cv4k1, the residual pdv8m left behind. pdv8m
    // widened `buildSymbolId` so the LEAF separator was right (`.handle` on both
    // sides), but the PARENT CHAIN still collapsed the same tri-state: the
    // enclosing instance method entered the chain through `buildParentPath`,
    // which joined every segment with the language's scopeSeparator
    // unconditionally, so `register` composed as `Registry.register` while the
    // codegraph walker composed `Registry#register`. The chunker emitted
    // `Registry.register.handle` against a cg_symbols holding
    // `Registry#register.handle`.
    it("scopes a call-argument object member under the enclosing INSTANCE METHOD, `#` not `.`", async () => {
      const ids = await chunkerCallableIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT_IN_METHOD);
      expect(ids).toContain("Registry#register.handle");
      expect(ids).not.toContain("Registry.register.handle");
    });

    it("emits no callable id absent from cg_symbols — call-argument object inside a method", async () => {
      const graphIds = new Set(codegraphIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT_IN_METHOD));
      for (const id of await chunkerCallableIds(TYPESCRIPT, CALL_ARGUMENT_OBJECT_IN_METHOD)) {
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

    /**
     * bd tea-rags-mcp-grz07 — the module-level const-bound function expression,
     * the dominant declaration shape in React code. Before the fix NEITHER side
     * named it: cg_symbols had no row a bare call could target, and the chunker
     * emitted no chunk at all, so the function was invisible to `find_symbol`
     * as well as to `get_callers`.
     */
    const MODULE_LEVEL_CONST_ARROW = [
      "export const genValidationSchema = (message: string): string => {",
      "  const trimmed = message.trim();",
      "  return trimmed.toUpperCase();",
      "};",
    ].join("\n");

    const MODULE_LEVEL_CONST_FUNCTION_EXPRESSION = [
      "const legacyExpression = function (value: number): number {",
      "  const doubled = value * 2;",
      "  return doubled + 1;",
      "};",
    ].join("\n");

    /** The boundary case: the SAME shape, one scope deeper. */
    const FUNCTION_SCOPED_CONST_ARROW = [
      "export function render(id: string): void {",
      "  const handler = (value: string): string => {",
      "    const trimmed = value.trim();",
      "    return trimmed.toUpperCase();",
      "  };",
      "  handler(id);",
      "}",
    ].join("\n");

    it("names a module-level const arrow the same on both sides", async () => {
      expect(await chunkerCallableIds(TYPESCRIPT, MODULE_LEVEL_CONST_ARROW)).toEqual(["genValidationSchema"]);
      expect(codegraphIds(TYPESCRIPT, MODULE_LEVEL_CONST_ARROW)).toContain("genValidationSchema");
    });

    it("names a module-level const function expression the same on both sides", async () => {
      expect(await chunkerCallableIds(TYPESCRIPT, MODULE_LEVEL_CONST_FUNCTION_EXPRESSION)).toEqual([
        "legacyExpression",
      ]);
      expect(codegraphIds(TYPESCRIPT, MODULE_LEVEL_CONST_FUNCTION_EXPRESSION)).toContain("legacyExpression");
    });

    it("names a function-scoped const arrow on NEITHER side", async () => {
      // Both producers must decline together. A chunk carrying `handler` with no
      // cg_symbols row is the ghost this file exists to catch, and a cg_symbols
      // row for `handler` is what bd tea-rags-mcp-w7qv4's guard exists to avoid.
      expect(await chunkerCallableIds(TYPESCRIPT, FUNCTION_SCOPED_CONST_ARROW)).toEqual(["render"]);
      expect(codegraphIds(TYPESCRIPT, FUNCTION_SCOPED_CONST_ARROW)).not.toContain("handler");
      expect(codegraphIds(TYPESCRIPT, FUNCTION_SCOPED_CONST_ARROW)).not.toContain("render.handler");
    });

    it.each([
      ["module-level const arrow", MODULE_LEVEL_CONST_ARROW],
      ["module-level const function expression", MODULE_LEVEL_CONST_FUNCTION_EXPRESSION],
      ["function-scoped const arrow", FUNCTION_SCOPED_CONST_ARROW],
    ])("emits no callable id absent from cg_symbols — %s", async (_shape, src) => {
      const graphIds = new Set(codegraphIds(TYPESCRIPT, src));
      for (const id of await chunkerCallableIds(TYPESCRIPT, src)) {
        expect([...graphIds]).toContain(id);
      }
    });

    it("still emits no chunk for a data-only const or a const bound to a call", async () => {
      const src = [
        "export const PALETTE = { red: '#f00', blue: '#00f', green: '#0f0' };",
        "export const translate = useTranslation('some-namespace-key');",
      ].join("\n");
      expect(await chunkerCallableIds(TYPESCRIPT, src)).toEqual([]);
      expect(codegraphIds(TYPESCRIPT, src)).toEqual([]);
    });
  });

  describe("JavaScript", () => {
    // JavaScript shares `method_definition` and delegates `jsNameOf` to
    // `tsNameOf`, so the const-object namespace reaches cg_symbols there too.
    //
    // This case is declared WITHOUT `export` for a historical reason worth
    // keeping: `export_statement` used to sit in JavaScript's chunkableTypes, so
    // the walk stopped at it and every exported declaration — class, function,
    // arrow, namespace alike — collapsed into one nameless block chunk with no
    // symbolId, which no lockstep assertion could survive. Removing that entry
    // (bd tea-rags-mcp-hlgak) is what lets the exported twin below be pinned
    // too. The unexported form stays as its own case: it is the shape the
    // original bead reduced, and dropping it would lose a corner case.
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

    // The same shape behind an `export`. `jsNameOf` always named it; the chunker
    // reached it only once `export_statement` left chunkableTypes, so this is the
    // half of the lockstep hlgak restores.
    const JS_EXPORTED_CONST_OBJECT_NAMESPACE = `export ${JS_CONST_OBJECT_NAMESPACE}`;

    it("names an EXPORTED const-object namespace member the same on both sides", async () => {
      expect(await chunkerCallableIds(JAVASCRIPT, JS_EXPORTED_CONST_OBJECT_NAMESPACE)).toEqual([
        "FileLevelGrouper.group",
      ]);
      expect(codegraphIds(JAVASCRIPT, JS_EXPORTED_CONST_OBJECT_NAMESPACE)).toContain("FileLevelGrouper.group");
    });

    it("emits no callable id absent from cg_symbols for an exported declaration", async () => {
      const graphIds = new Set(codegraphIds(JAVASCRIPT, JS_EXPORTED_CONST_OBJECT_NAMESPACE));
      for (const id of await chunkerCallableIds(JAVASCRIPT, JS_EXPORTED_CONST_OBJECT_NAMESPACE)) {
        expect([...graphIds]).toContain(id);
      }
    });

    /**
     * bd tea-rags-mcp-grz07 parity guard. `jsNameOf` DELEGATES to `tsNameOf`
     * first and only then applies its own pattern #5
     * (`const Foo = function () {}` / arrow, at ANY scope). Teaching `tsNameOf`
     * the module-level half of that shape therefore re-routes which branch
     * answers for JavaScript, and the answer must not change:
     *
     *   - module level — `tsNameOf` now answers, so it must return exactly what
     *     pattern #5 returned (`{ name, descendsInto: false }`);
     *   - function scope — `tsNameOf` declines by design, so pattern #5 still
     *     answers and JavaScript keeps naming it, as it always has.
     *
     * The two languages deliberately DIFFER on the second case, and that is not
     * drift: JavaScript's `jsNameOf` has named function-scoped consts since long
     * before the TypeScript resolver grew a scope guard to protect.
     */
    it("keeps naming a const arrow at BOTH scopes, module-level via the shared branch", () => {
      const moduleLevel = codegraphIds(JAVASCRIPT, "export const handler = (value) => value;\n");
      expect(moduleLevel).toContain("handler");

      const functionScoped = codegraphIds(
        JAVASCRIPT,
        "export function render(id) {\n  const handler = (value) => value;\n  return handler(id);\n}\n",
      );
      expect(functionScoped).toContain("render");
      expect(functionScoped).toContain("render.handler");
    });
  });
});
