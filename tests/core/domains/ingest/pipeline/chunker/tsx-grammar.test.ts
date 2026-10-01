/**
 * A `.tsx` file is chunked under the grammar its extension selects.
 *
 * `.ts` and `.tsx` both map to language "typescript", and the chunker used to
 * hold ONE parser per language built with no extension — the plain
 * `typescript` grammar. JSX then parsed into ERROR nodes, the component's
 * `function_declaration` was never recognized, and only fragments survived
 * (a taxdome page component kept 79 of 1296 non-blank lines, and a bogus
 * `function if` symbol). The parser must follow the file's extension, exactly
 * as the codegraph walk already did (bd tea-rags-mcp-vqdi6).
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { AstNode } from "../../../../../../src/core/contracts/types/ast.js";
import { TreeSitterChunker } from "../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../../../../../src/core/domains/language/index.js";
import type { CodeChunk } from "../../../../../../src/core/types.js";

/** ERROR nodes in a materialized tree (it carries no `hasError`); -1 for no tree. */
function errorNodeCount(node: AstNode | undefined): number {
  if (!node) return -1;
  const own = node.type === "ERROR" ? 1 : 0;
  return node.children.reduce((sum, child) => sum + errorNodeCount(child), own);
}

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

const COMPONENT = [
  'import { useState } from "react";',
  'import { Button } from "./Button";',
  "",
  "export function ClientDocumentsPage({ clientId }: { clientId: string }) {",
  "  const [open, setOpen] = useState(false);",
  "  if (!clientId) {",
  '    return <div className="empty">No client selected for this page</div>;',
  "  }",
  "  return (",
  '    <section className="documents">',
  "      <Button onClick={() => setOpen(!open)}>Toggle the document list</Button>",
  "      {open && <ul>{renderDocuments(clientId)}</ul>}",
  "    </section>",
  "  );",
  "}",
  "",
].join("\n");

describe("TreeSitterChunker — .tsx is chunked under the tsx grammar", () => {
  let chunker: TreeSitterChunker;

  beforeEach(() => {
    chunker = new TreeSitterChunker(
      { chunkSize: 4500, chunkOverlap: 450, maxChunkSize: 4500 },
      new DefaultSymbolIdComposer(),
      new LanguageFactory(),
    );
  });

  it("parses a JSX component without errors and chunks it as one function symbol", async () => {
    const { chunks, tree } = await chunker.chunkWithTree(COMPONENT, "/repo/ClientDocumentsPage.tsx", "typescript");

    expect(errorNodeCount(tree?.rootNode)).toBe(0);
    expect(chunks.map((c) => c.metadata.symbolId)).toEqual(["ClientDocumentsPage"]);
    expect(chunks[0].metadata.chunkType).toBe("function");
    expect(chunks[0].startLine).toBe(4);
    expect(chunks[0].endLine).toBe(15);
  });

  it("covers every non-blank line of the component except its imports", async () => {
    const chunks = await chunker.chunk(COMPONENT, "/repo/ClientDocumentsPage.tsx", "typescript");

    expect(uncoveredNonBlankLines(COMPONENT, chunks)).toEqual([
      '1: import { useState } from "react";',
      '2: import { Button } from "./Button";',
    ]);
  });

  it("keeps parsing .ts files under the typescript grammar (a type assertion `<T>x` is not JSX)", async () => {
    const code = [
      "export function castValue(input: unknown): number {",
      "  const value = <number>input;",
      "  return value * 2 + computeOffsetForTheValue(value);",
      "}",
      "",
    ].join("\n");

    const { chunks, tree } = await chunker.chunkWithTree(code, "/repo/cast.ts", "typescript");

    expect(errorNodeCount(tree?.rootNode)).toBe(0);
    expect(chunks.map((c) => c.metadata.symbolId)).toEqual(["castValue"]);
  });

  it("chunks .ts and .tsx files alternately through one chunker without crossing grammars", async () => {
    const ts = "export function castValue(input: unknown): number {\n  return <number>input * 2 + 1000000;\n}\n";
    const first = await chunker.chunkWithTree(ts, "/repo/a.ts", "typescript");
    const second = await chunker.chunkWithTree(COMPONENT, "/repo/B.tsx", "typescript");
    const third = await chunker.chunkWithTree(ts, "/repo/c.ts", "typescript");

    expect(errorNodeCount(first.tree?.rootNode)).toBe(0);
    expect(errorNodeCount(second.tree?.rootNode)).toBe(0);
    expect(errorNodeCount(third.tree?.rootNode)).toBe(0);
    expect(chunker.getLoadedParsers().loaded).toEqual(["typescript"]);
  });
});
