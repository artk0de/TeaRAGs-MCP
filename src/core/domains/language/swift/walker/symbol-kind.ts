/**
 * Swift symbol kinds (tea-rags-mcp-vi0wx) — the declaration kind of a node,
 * stamped on its chunk as `ChunkExtraction.symbolKind`:
 *
 *   | node                                                  | kind       |
 *   | ----------------------------------------------------- | ---------- |
 *   | `class_declaration` — `class` / `struct` / `actor`    | class      |
 *   | `class_declaration` — `enum`                          | enum       |
 *   | `class_declaration` — `extension`                     | none       |
 *   | `protocol_declaration`                                | interface  |
 *   | `function_declaration` at file scope                  | function   |
 *   | `function_declaration` in a type / extension          | method     |
 *   | `protocol_function_declaration`                       | method     |
 *   | `init_declaration` / `deinit_declaration`             | method     |
 *   | `subscript_declaration`                               | method     |
 *   | `typealias_declaration`                               | type_alias |
 *
 * tree-sitter-swift gives class, struct, enum, actor AND extension one node
 * type, so the keyword (`swiftTypeDeclarationKind`) rides in the context. An
 * extension re-opens a type declared elsewhere: it declares no kind of its own,
 * and tagging it `class` would count one type twice in any per-kind census.
 *
 * The mapping covers `deinit` / `subscript` / `typealias` although `swiftNameOf`
 * names none of them today — the chunker emits no chunk for them, so the walker
 * has nothing to stamp. Adding those chunks moves the chunk set (a chunking bump
 * and a full reindex), which is out of this mapping's reach.
 */

import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";
import type { TypeDeclarationKind } from "../../../../contracts/types/codegraph.js";

export interface SwiftSymbolKindContext {
  /** No enclosing type, extension or protocol declaration. */
  readonly atTopLevel: boolean;
  /** A `class_declaration`'s keyword, as `swiftTypeDeclarationKind` reads it. */
  readonly typeKeyword?: TypeDeclarationKind | "extension" | null;
}

export function symbolKindOf(nodeType: string, context: SwiftSymbolKindContext): SymbolDefinitionKind | undefined {
  switch (nodeType) {
    case "class_declaration":
      return classDeclarationKind(context.typeKeyword);
    case "protocol_declaration":
      return "interface";
    case "function_declaration":
      return context.atTopLevel ? "function" : "method";
    case "protocol_function_declaration":
    case "init_declaration":
    case "deinit_declaration":
    case "subscript_declaration":
      return "method";
    case "typealias_declaration":
      return "type_alias";
    default:
      return undefined;
  }
}

function classDeclarationKind(keyword: SwiftSymbolKindContext["typeKeyword"]): SymbolDefinitionKind | undefined {
  switch (keyword) {
    case "class":
    case "struct":
    case "actor":
      return "class";
    case "enum":
      return "enum";
    // `protocol` is its own node type (mapped above), never a class_declaration.
    case "protocol":
    case "extension":
    case null:
    case undefined:
      return undefined;
  }
}
