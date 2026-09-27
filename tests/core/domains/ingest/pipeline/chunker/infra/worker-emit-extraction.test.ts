/**
 * yl9tv equivalence test: the chunker worker now emits a codegraph
 * `FileExtraction` from the SAME parse it chunks with. This test proves the
 * tree the chunker surfaces via `chunkWithTree` produces a FileExtraction
 * IDENTICAL to the codegraph provider's direct-mode path (a fresh independent
 * re-parse + the same `collectSymbols` + `walker.walk`). If the two diverged —
 * e.g. the kernel `scopeSeparator` disagreed with the provider's — the deep
 * equality below would fail.
 */
import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import type { MaterializedTree } from "../../../../../../../src/core/contracts/types/ast.js";
import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type {
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../../../../../src/core/contracts/types/language.js";
import { extractFromChunkerParse } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/cross-pass-extraction.js";
import { TreeSitterChunker } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import {
  collectSymbols,
  DefaultSymbolIdComposer,
  LanguageFactory,
} from "../../../../../../../src/core/domains/language/index.js";
import { extractFileInMemory } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/in-memory-extraction.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

const RELPATH = "app/models/user.rb";
const RUBY = [
  "module Acme",
  "  class User",
  "    def initialize(name)",
  "      @name = name",
  "    end",
  "    def greet",
  "      notify(@name)",
  "    end",
  "  end",
  "end",
  "",
].join("\n");

// Mirror of the worker's emit-extraction path (worker.ts): walk a parsed tree
// with the language's walker, feeding it the kernel-composed symbol ranges.
function extractFromTree(
  factory: LanguageFactoryDescriptor,
  composer: SymbolIdComposer,
  tree: Parser.Tree,
  code: string,
  relPath: string,
  language: string,
): FileExtraction {
  const provider = factory.create(language);
  const { walker } = provider;
  if (!walker) throw new Error(`no walker for ${language}`);
  const ranges = collectSymbols(
    tree,
    walker.nameOf,
    provider.kernel.scopeSeparator ?? ".",
    provider.kernel.disambiguateOverloads ?? false,
    composer,
  );
  return walker.walk({ tree, code, relPath, language, chunks: ranges });
}

describe("worker single-parse extraction equivalence (yl9tv)", () => {
  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };

  it("extraction from the chunker's surfaced tree deep-equals a fresh re-parse (extractOneFile parity)", async () => {
    const chunker = new TreeSitterChunker(config, composer, factory);

    // Worker path: the chunker's SINGLE parse, surfaced via chunkWithTree.
    const { tree } = await chunker.chunkWithTree(RUBY, RELPATH, "ruby");
    expect(tree).not.toBeNull();
    const fromChunkerParse = extractFromTree(factory, composer, tree as Parser.Tree, RUBY, RELPATH, "ruby");

    // extractOneFile path: a fresh, independent parse of the same source.
    const parser = new Parser();
    parser.setLanguage(RbLang);
    const fromFreshParse = extractFromTree(factory, composer, parser.parse(RUBY), RUBY, RELPATH, "ruby");

    expect(fromChunkerParse).toEqual(fromFreshParse);

    // Sanity: nested module/class/instance-method symbols composed correctly,
    // and the call site inside `greet` was captured.
    const ids = fromChunkerParse.chunks.map((c) => c.symbolId);
    expect(ids).toContain("Acme::User#initialize");
    expect(ids).toContain("Acme::User#greet");
    const greet = fromChunkerParse.chunks.find((c) => c.symbolId === "Acme::User#greet");
    expect(greet?.calls.some((call) => call.callText.includes("notify"))).toBe(true);
  });

  it("returns a null tree (no extraction possible) for an unsupported language", async () => {
    const chunker = new TreeSitterChunker(config, composer, factory);
    const { tree } = await chunker.chunkWithTree("some plain text\n", "notes.unknownext", "unknownlang");
    expect(tree).toBeNull();
  });
});

// bd tea-rags-mcp-vqdi6: the chunker parses every TypeScript file with ONE
// grammar, while the codegraph walk selects it by extension. A `.tsx` file walked
// on the chunk tree lost its JSX-embedded call sites on the full-index path.
describe("cross-pass extraction walks under the extension's codegraph grammar (vqdi6)", () => {
  const factory = new LanguageFactory();
  const composer = new DefaultSymbolIdComposer();
  const config: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };
  const TSX_PATH = "/repo/app/javascript/PriorityPill.tsx";
  const TSX = [
    'import { PipelineJobHelper } from "./PipelineJobHelper";',
    "",
    "export function PriorityPill({ priority }: { priority: string }) {",
    "  const color = PipelineJobHelper.getPriorityColor(priority);",
    "  return (",
    "    <div className={color} onClick={() => track(priority)}>",
    "      {formatPriority(priority)}",
    "    </div>",
    "  );",
    "}",
    "",
  ].join("\n");

  it("a .tsx file's extraction equals the codegraph provider's own (extractFileInMemory)", async () => {
    const chunker = new TreeSitterChunker(config, composer, factory);
    const { tree } = await chunker.chunkWithTree(TSX, TSX_PATH, "typescript");
    expect(tree).not.toBeNull();

    const crossPass = await extractFromChunkerParse(
      { chunker, languageFactory: factory, composer, collectSymbols },
      { filePath: TSX_PATH, code: TSX, language: "typescript" },
      tree as MaterializedTree,
    );
    const direct = extractFileInMemory({ languageFactory: factory, collectSymbols, composer }, TSX_PATH, TSX);

    expect(direct).not.toBeNull();
    expect(crossPass).toEqual(direct);
    const callTexts = (crossPass?.chunks ?? []).flatMap((chunk) => chunk.calls.map((call) => call.callText));
    expect(callTexts.some((text) => text.includes("formatPriority"))).toBe(true);
    expect(callTexts.some((text) => text.includes("track"))).toBe(true);
  });

  it("a .ts file walks the chunk parse itself — no second parse when the grammars agree", async () => {
    const chunker = new TreeSitterChunker(config, composer, factory);
    const code = "export function f() {\n  return g(1);\n}\n";
    const { tree } = await chunker.chunkWithTree(code, "/repo/a.ts", "typescript");
    expect(await chunker.walkTreeFor(code, "/repo/a.ts", "typescript", tree as MaterializedTree)).toBe(tree);
  });
});
