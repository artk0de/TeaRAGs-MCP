import type { AstNode, MaterializedTree } from "../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { CallRef, ChunkExtraction, FileExtraction, ImportRef } from "../../../../contracts/types/codegraph.js";
import { assignCallsToInnermostChunks, symbolIdNames } from "../../kernel/index.js";
import { objcNameOf } from "./name-of.js";
import { symbolKindOf } from "./symbol-kind.js";

export interface ObjcExtractInput {
  tree: MaterializedTree;
  code: string;
  relPath: string;
  language: string;
  chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
}

export function extractFromObjcFile(input: ObjcExtractInput): FileExtraction {
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
    const symbolKind = symbolKinds
      .get(chunk.startLine)
      ?.find((reading) => symbolIdNames(chunk.symbolId, reading.name))?.kind;
    if (symbolKind !== undefined) out.symbolKind = symbolKind;
    return out;
  });
  return { relPath: input.relPath, language: input.language, imports, chunks, fileScope: [] };
}

interface ObjcSymbolKindReading {
  readonly name: string;
  readonly kind: SymbolDefinitionKind;
}

function collectSymbolKinds(root: AstNode): Map<number, ObjcSymbolKindReading[]> {
  const map = new Map<number, ObjcSymbolKindReading[]>();
  const visit = (node: AstNode): void => {
    const named = objcNameOf(node);
    const kind = symbolKindOf(node.type);
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
    if (node.type === "preproc_include") {
      const path = node.childForFieldName("path");
      if (path) {
        imports.push({
          importText: path.text.replace(/^["<]|[">]$/g, ""),
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
    if (node.type === "message_expression") {
      const method = node.childForFieldName("method");
      const receiver = node.childForFieldName("receiver");
      if (method) {
        calls.push({
          callText: node.text,
          receiver: receiver?.text ?? null,
          member: method.text,
          startLine: node.startPosition.row + 1,
        });
      }
    }
    if (node.type === "call_expression") {
      const callee =
        node.childForFieldName("function") ?? node.namedChildren.find((child) => child.type === "identifier");
      if (callee?.type === "identifier") {
        calls.push({
          callText: node.text,
          receiver: null,
          member: callee.text,
          startLine: node.startPosition.row + 1,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return calls;
}
