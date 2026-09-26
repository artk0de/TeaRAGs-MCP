/**
 * Go symbol kinds (tea-rags-mcp-vi0wx) — the declaration kind of every node
 * `goNameOf` names, stamped on its chunk as `ChunkExtraction.symbolKind`:
 *
 *   | node                                  | kind       |
 *   | ------------------------------------- | ---------- |
 *   | `function_declaration`                | function   |
 *   | `method_declaration` (has a receiver) | method     |
 *   | `type_spec` over `struct_type`        | class      |
 *   | `type_spec` over `interface_type`     | interface  |
 *   | `type_spec` over anything else        | class      |
 *   | `type_alias` (`type X = Y`)           | type_alias |
 *
 * A defined type over a non-struct (`type ID int`, `type Handler func()`) is a
 * NEW named type that can carry methods, so it is a class; only a true alias
 * names an existing type. Go has no position-dependent kind (no nested funcs,
 * methods only at package level), so unlike the plan's shared shape the context
 * carries only what a `type_spec` needs: the node type of its `type` field.
 *
 * Package-level `const` is not tagged: neither the chunker nor `goNameOf` emits a
 * symbol for it, and adding one would move the chunk set.
 */

import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export interface GoSymbolKindContext {
  /** The node type of a `type_spec`'s `type` field (`struct_type`, `interface_type`, …). */
  readonly typeBody?: string;
}

export function symbolKindOf(nodeType: string, context: GoSymbolKindContext = {}): SymbolDefinitionKind | undefined {
  switch (nodeType) {
    case "function_declaration":
      return "function";
    case "method_declaration":
      return "method";
    case "type_spec":
      return context.typeBody === "interface_type" ? "interface" : "class";
    case "type_alias":
      return "type_alias";
    default:
      return undefined;
  }
}
