import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks, symbolIdNames } from "../../kernel/index.js";
import { kotlinCallSiteShape } from "./call-site.js";
import { kotlinNameOf } from "./name-of.js";
import { symbolKindOf } from "./symbol-kind.js";

export interface KotlinExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[]; bodyScope?: string[] }[];
}

export function extractFromKotlinFile(input: KotlinExtractInput): FileExtraction {
  const imports = collectImports(input.tree.rootNode);
  const calls = collectCalls(input.tree.rootNode);
  const callOwnership = assignCallsToInnermostChunks(calls, input.chunks);
  const symbolKinds = collectSymbolKinds(input.tree.rootNode);
  const chunks: ChunkExtraction[] = input.chunks.map((chunk, chunkIndex) => {
    const out: ChunkExtraction = {
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      calls: callOwnership.get(chunkIndex) ?? [],
    };
    if (chunk.bodyScope !== undefined) out.bodyScope = chunk.bodyScope;
    const symbolKind = symbolKinds
      .get(chunk.startLine)
      ?.find((reading) => symbolIdNames(chunk.symbolId, reading.name))?.kind;
    if (symbolKind !== undefined) out.symbolKind = symbolKind;
    return out;
  });
  return { relPath: input.relPath, language: input.language, imports, chunks, fileScope: [] };
}

interface KotlinSymbolKindReading {
  readonly name: string;
  readonly kind: SymbolDefinitionKind;
}

function collectSymbolKinds(root: AstNode): Map<number, KotlinSymbolKindReading[]> {
  const map = new Map<number, KotlinSymbolKindReading[]>();
  const visit = (node: AstNode): void => {
    const named = kotlinNameOf(node);
    const kind = named ? symbolKindOf(node) : undefined;
    if (named && kind) {
      const line = node.startPosition.row + 1;
      const list = map.get(line) ?? [];
      list.push({ name: named.name, kind });
      map.set(line, list);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return map;
}

function collectImports(root: AstNode): ImportRef[] {
  const imports: ImportRef[] = [];
  const visit = (node: AstNode): void => {
    if (node.type === "import") {
      const qualified = node.namedChildren.find((child) => child.type === "qualified_identifier");
      if (qualified) {
        const star = node.children.some((child) => child.text === "*" || child.text === ".*");
        imports.push({
          importText: star ? `${qualified.text}.*` : qualified.text,
          startLine: node.startPosition.row + 1,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return imports;
}

function collectCalls(root: AstNode): CallRef[] {
  const calls: CallRef[] = [];
  const visit = (node: AstNode): void => {
    const shape = kotlinCallSiteShape(node);
    if (shape) {
      calls.push({
        callText: node.text,
        receiver: shape.receiver,
        member: shape.member,
        startLine: node.startPosition.row + 1,
      });
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return calls;
}
