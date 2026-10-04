/**
 * The MODULE remainder: top-level source no chunk carries.
 *
 * `chunkWithTree` emitted only the chunkable nodes it found, and fell back to
 * character chunking only when there were none. So a file holding one small
 * function beside a 1,100-line top-level `const sidebarLoaders = { … }` kept
 * the function (5 lines) and dropped the object — every top-level statement
 * that is not a chunkable node vanished as soon as ONE chunk existed. The
 * container remainder (bd tea-rags-mcp-deoki) covers the rows inside a class /
 * module container; this is its top-level counterpart.
 *
 * Invariants pinned here, through the real `TreeSitterChunker`:
 *   1. every non-blank top-level row except import / re-export statements is
 *      inside some chunk's coverage (`lineRanges` when present);
 *   2. a remainder that is exactly one named declaration carries its name and
 *      symbolId (split parts `#partN`), so `find_symbol` resolves it;
 *   3. a file whose top level is already covered gets no remainder chunk.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

const MAX = 4500;

function coveredLines(chunks: CodeChunk[]): Set<number> {
  const covered = new Set<number>();
  for (const c of chunks) {
    const ranges = c.metadata.lineRanges?.length ? c.metadata.lineRanges : [{ start: c.startLine, end: c.endLine }];
    for (const r of ranges) for (let l = r.start; l <= r.end; l++) covered.add(l);
  }
  return covered;
}

function uncoveredNonBlankLines(code: string, chunks: CodeChunk[]): string[] {
  const covered = coveredLines(chunks);
  return code
    .split("\n")
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text, line }) => text.trim() !== "" && !covered.has(line))
    .map(({ text, line }) => `${line}: ${text}`);
}

const HOOK = [
  "export function useLoaders(): Record<string, () => Promise<unknown>> {",
  "  const registry = buildRegistryFromTheSidebarLoaders(loaders);",
  "  return registry;",
  "}",
  "",
].join("\n");

function loadersObject(entries: number): string {
  const rows = Array.from(
    { length: entries },
    (_, i) => `  sidebarEntry${i}: () => import("./sidebars/SidebarEntryComponent${i}"),`,
  );
  return ["const loaders: Record<string, () => Promise<unknown>> = {", ...rows, "};", ""].join("\n");
}

describe("TreeSitterChunker — module remainder", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: MAX, chunkOverlap: 450, maxChunkSize: MAX },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("keeps a large top-level object declared AFTER the only function", async () => {
    const code = `${HOOK}\n${loadersObject(200)}`;
    const chunks = await chunker.chunk(code, "/repo/initSidebarLoaders.ts", "typescript");

    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    expect(chunks.every((c) => c.content.length <= MAX)).toBe(true);
    const parts = chunks.filter((c) => c.metadata.parentSymbolId === "loaders");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((c) => c.metadata.symbolId)).toEqual(parts.map((_, i) => `loaders#part${i + 1}`));
    expect(parts.every((c) => c.metadata.chunkType === "block")).toBe(true);
    // The parts tile the declaration exactly, in source order.
    expect(parts[0].startLine).toBe(6);
    expect(parts[parts.length - 1].endLine).toBe(207);
    for (let i = 1; i < parts.length; i++) expect(parts[i].startLine).toBe(parts[i - 1].endLine + 1);
  });

  it("keeps a large top-level object declared BEFORE the only function", async () => {
    const code = `${loadersObject(200)}\n${HOOK}`;
    const chunks = await chunker.chunk(code, "/repo/initSidebarLoaders.ts", "typescript");

    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    expect(chunks.some((c) => c.metadata.symbolId === "useLoaders")).toBe(true);
    expect(chunks.some((c) => c.metadata.symbolId === "loaders#part1")).toBe(true);
    // Emitted in source order: the object's parts come before the function.
    const firstLoaderPart = chunks.findIndex((c) => c.metadata.parentSymbolId === "loaders");
    const hook = chunks.findIndex((c) => c.metadata.symbolId === "useLoaders");
    expect(firstLoaderPart).toBeLessThan(hook);
  });

  it("names a remainder that fits one chunk after its single declaration", async () => {
    const code = `${HOOK}\n${loadersObject(5)}`;
    const chunks = await chunker.chunk(code, "/repo/initSidebarLoaders.ts", "typescript");

    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    const remainder = chunks.find((c) => c.metadata.symbolId === "loaders");
    expect(remainder).toMatchObject({ startLine: 6, endLine: 12 });
    expect(remainder?.metadata).toMatchObject({ name: "loaders", chunkType: "block" });
    expect(remainder?.metadata.lineRanges).toBeUndefined();
  });

  it("adds no remainder to a file of imports and functions only", async () => {
    const code = [
      'import { a } from "./a";',
      'export { b } from "./b";',
      'export * from "./c";',
      "",
      "export function first(): number {",
      "  return a() + computeTheFirstValueOfTheModule();",
      "}",
      "",
      "export function second(): number {",
      "  return a() * computeTheSecondValueOfTheModule();",
      "}",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/plain.ts", "typescript");

    expect(chunks.map((c) => c.metadata.symbolId)).toEqual(["first", "second"]);
  });

  it("groups scattered small top-level statements into one remainder with line ranges", async () => {
    const code = [
      "const DEFAULT_TIMEOUT_IN_MILLISECONDS = 30_000; // the shared timeout",
      "",
      "export function first(): number {",
      "  return DEFAULT_TIMEOUT_IN_MILLISECONDS + computeTheFirstValue();",
      "}",
      "",
      'registerTheModuleWithTheGlobalRegistry("scattered-module");',
      "",
      "export function second(): number {",
      "  return DEFAULT_TIMEOUT_IN_MILLISECONDS * computeTheSecondValue();",
      "}",
      "",
      "let mutableCounterForTheModule = 0;",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/scattered.ts", "typescript");

    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    const remainders = chunks.filter((c) => c.metadata.symbolId !== "first" && c.metadata.symbolId !== "second");
    expect(remainders).toHaveLength(1);
    expect(remainders[0].metadata.chunkType).toBe("block");
    expect(remainders[0].metadata.symbolId).toBeUndefined();
    expect(remainders[0].metadata.lineRanges).toEqual([
      { start: 1, end: 1 },
      { start: 7, end: 7 },
      { start: 13, end: 13 },
    ]);
    expect(remainders[0].startLine).toBe(1);
    expect(remainders[0].endLine).toBe(13);
  });

  it("drops a remainder below the 50-char noise floor", async () => {
    const code = [
      "export function first(): number {",
      "  return computeTheFirstValueOfTheModule() + 1;",
      "}",
      "",
      "let n = 0;",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/tiny.ts", "typescript");

    expect(chunks.map((c) => c.metadata.symbolId)).toEqual(["first"]);
  });

  it("keeps ruby `require` calls out (the language's isModuleImport) while keeping top-level code", async () => {
    const code = [
      'require "active_support/core_ext/string/inflections"',
      'require_relative "../lib/the_shared_loader_registry"',
      "",
      "module Loaders",
      "  def self.build",
      "    REGISTRY.transform_values { |loader| loader.call(:with_defaults) }",
      "  end",
      "end",
      "",
      "Loaders.configure_the_registry_with_defaults!(strict: true)",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/loaders.rb", "ruby");

    // The module's header / `end` rows ride its members as their hierarchy
    // prefix (the container remainder's rule); only the requires stay out.
    const uncovered = uncoveredNonBlankLines(code, chunks);
    expect(uncovered).toContain('1: require "active_support/core_ext/string/inflections"');
    expect(uncovered).toContain('2: require_relative "../lib/the_shared_loader_registry"');
    expect(chunks.find((c) => c.startLine === 10)?.content).toBe(
      "Loaders.configure_the_registry_with_defaults!(strict: true)",
    );
  });

  it("works for a language without a hook chain (python module-level dict)", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => `    "entry_${i}": load_the_entry_component_number_${i},`);
    const code = [
      "def build_registry():",
      "    return {key: value() for key, value in LOADERS.items()}",
      "",
      "",
      "LOADERS = {",
      ...rows,
      "}",
      "",
    ].join("\n");
    const chunks = await chunker.chunk(code, "/repo/loaders.py", "python");

    expect(uncoveredNonBlankLines(code, chunks)).toEqual([]);
    expect(chunks.find((c) => c.metadata.symbolId === "LOADERS")).toMatchObject({ startLine: 5, endLine: 16 });
  });
});
