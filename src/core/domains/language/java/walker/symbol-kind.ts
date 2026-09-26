/**
 * Java symbol kinds (tea-rags-mcp-vi0wx) — the declaration kind of a node,
 * stamped on its chunk as `ChunkExtraction.symbolKind`:
 *
 *   | node                          | kind      |
 *   | ----------------------------- | --------- |
 *   | `class_declaration`           | class     |
 *   | `record_declaration`          | class     |
 *   | `interface_declaration`       | interface |
 *   | `annotation_type_declaration` | interface |
 *   | `enum_declaration`            | enum      |
 *   | `method_declaration`          | method    |
 *   | `constructor_declaration`     | method    |
 *
 * Java has no free functions and no position-dependent kind — every method,
 * static or not, is a member of a type — so the mapping reads the node type
 * alone. Only nodes `javaNameOf` names reach a chunk: records and annotation
 * types are mapped for completeness but carry no chunk today, and a
 * `static final` field (the plan's constant) is not tagged because neither the
 * chunker nor `javaNameOf` emits a symbol for it — adding one would move the
 * chunk set.
 */

import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export function symbolKindOf(nodeType: string): SymbolDefinitionKind | undefined {
  switch (nodeType) {
    case "class_declaration":
    case "record_declaration":
      return "class";
    case "interface_declaration":
    case "annotation_type_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "method_declaration":
    case "constructor_declaration":
      return "method";
    default:
      return undefined;
  }
}
