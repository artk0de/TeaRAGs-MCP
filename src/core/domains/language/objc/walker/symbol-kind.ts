import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export function symbolKindOf(nodeType: string): SymbolDefinitionKind | undefined {
  switch (nodeType) {
    case "class_implementation":
    case "class_interface":
      return "class";
    case "protocol_declaration":
      return "interface";
    case "method_definition":
    case "method_declaration":
      return "method";
    case "function_definition":
      return "function";
    default:
      return undefined;
  }
}
