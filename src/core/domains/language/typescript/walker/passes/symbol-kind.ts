/**
 * ECMAScript symbol kind (bd tea-rags-mcp-vi0wx) — fills
 * `ChunkExtraction.symbolKind` for every chunk the language's `nameOf` named,
 * from the node type that named it (`../symbol-kind.ts`).
 *
 * The monolith never sees node types: its chunks arrive as bare ranges from
 * `collectSymbols`. So the kind is a pass that re-reads the declarations the
 * SAME `nameOf` names and joins each reading onto its chunk the way
 * `kernel/declared-visibility-pass.ts` does — the chunk starting on the
 * reading's line whose id ends with the reading's name. A reading no chunk
 * matches is dropped: a pass never synthesizes a chunk, so this can add no
 * symbol and move no resolution.
 *
 * A class-like `nameOf` result that asks for `syntheticConstructorIfMissing`
 * also reads `constructor` as a method on the class line: `collectSymbols` puts
 * the implicit `Class#constructor` there, and it is as addressable as an
 * explicit one.
 *
 * TypeScript and JavaScript share it, each with its own `nameOf` (`jsNameOf`
 * delegates to `tsNameOf` and adds the CommonJS shapes).
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { SymbolDefinitionKind } from "../../../../../contracts/types/codegraph-symbols.js";
import type { ChunkExtraction, FileExtraction, NamedSymbol } from "../../../../../contracts/types/codegraph.js";
import { unwrapTypeAssertions } from "../../../../../infra/symbolid/index.js";
import { symbolIdNames, type ExtractionFacetPass } from "../../../kernel/index.js";
import { SYMBOL_KIND_NODE_TYPES, symbolKindOf, type EcmascriptSymbolKindContext } from "../symbol-kind.js";

interface SymbolKindReading {
  readonly name: string;
  readonly kind: SymbolDefinitionKind;
}

const MEMBER_SEPARATORS = /[#.]/;

/** Module level: the declaration's parent (through `export`) is the program. */
function declaresAtTopLevel(node: AstNode): boolean {
  let declaration = node.type === "variable_declarator" ? node.parent : node;
  if (declaration?.parent?.type === "export_statement") declaration = declaration.parent;
  return declaration?.parent?.type === "program";
}

function contextOf(node: AstNode, name: string): EcmascriptSymbolKindContext {
  const context: EcmascriptSymbolKindContext = { atTopLevel: declaresAtTopLevel(node) };
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value) context.valueType = unwrapTypeAssertions(value).type;
  } else if (node.type === "assignment_expression" || node.type === "call_expression") {
    context.memberTarget = MEMBER_SEPARATORS.test(name);
  }
  return context;
}

function readingsOf(node: AstNode, nameOf: (node: AstNode) => NamedSymbol | NamedSymbol[] | null): SymbolKindReading[] {
  const named = nameOf(node);
  if (named === null) return [];
  const readings: SymbolKindReading[] = [];
  for (const symbol of Array.isArray(named) ? named : [named]) {
    const kind = symbolKindOf(node.type, contextOf(node, symbol.name));
    if (kind === undefined) continue;
    readings.push({ name: symbol.name, kind });
    if (symbol.syntheticConstructorIfMissing === true) readings.push({ name: "constructor", kind: "method" });
  }
  return readings;
}

export function ecmascriptSymbolKindFacetPass(
  nameOf: (node: AstNode) => NamedSymbol | NamedSymbol[] | null,
): ExtractionFacetPass {
  return {
    run: (root, ctx): Partial<FileExtraction> => {
      if (ctx.chunks.length === 0) return {};
      const readingsByLine = new Map<number, SymbolKindReading[]>();
      const stack: AstNode[] = [root];
      for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
        if (SYMBOL_KIND_NODE_TYPES.has(node.type)) {
          const readings = readingsOf(node, nameOf);
          if (readings.length > 0) {
            const line = node.startPosition.row + 1;
            const onLine = readingsByLine.get(line);
            if (onLine === undefined) readingsByLine.set(line, readings);
            else onLine.push(...readings);
          }
        }
        for (const child of node.children) stack.push(child);
      }
      if (readingsByLine.size === 0) return {};
      const chunks: ChunkExtraction[] = [];
      for (const chunk of ctx.chunks) {
        const hit = readingsByLine.get(chunk.startLine)?.find((r) => symbolIdNames(chunk.symbolId, r.name));
        if (hit !== undefined) {
          chunks.push({ symbolId: chunk.symbolId, scope: chunk.scope, calls: [], symbolKind: hit.kind });
        }
      }
      return chunks.length > 0 ? { chunks } : {};
    },
  };
}
