/**
 * Rust type-abstractness census (bd tea-rags-mcp-r8hme.8): a trait is abstract;
 * a struct, enum or union is concrete. An `impl` block implements a type
 * declared elsewhere and counts as neither.
 */

import { typeAbstractnessFacetPass, type ExtractionFacetPass } from "../../../kernel/index.js";

const CONCRETE_ITEM_TYPES: ReadonlySet<string> = new Set(["struct_item", "enum_item", "union_item"]);

export const rustTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass((node) => {
  if (node.type === "trait_item") return "abstract";
  return CONCRETE_ITEM_TYPES.has(node.type) ? "concrete" : null;
});
