import type { SymbolDefinitionKind } from "../../../../contracts/types/codegraph-symbols.js";

export function symbolKindOf(nodeType: string): SymbolDefinitionKind | undefined {
  switch (nodeType) {
    case "class_declaration":
      return "class";
    // `SymbolDefinitionKind` has no `trait`. A trait is stamped `class` because
    // that is the class-shaped container the vocabulary already has.
    case "trait_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "enum_declaration":
      return "enum";
    case "namespace_definition":
      return "module";
    case "method_declaration":
      return "method";
    case "function_definition":
      return "function";
    default:
      return undefined;
  }
}
