/**
 * Go type-abstractness census (bd tea-rags-mcp-r8hme.8), read per `type_spec`:
 * an interface declaring a method is abstract; a struct is concrete. A
 * constraint interface (a type set such as `~int | ~float64`) and the empty
 * interface declare no behaviour, and a defined type over another type
 * (`type ID int`) adds none, so all three count as neither.
 */

import {
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";

export const readGoTypeAbstractness: TypeAbstractnessReader = (node) => {
  if (node.type !== "type_spec") return null;
  const type = node.childForFieldName("type");
  if (type?.type === "struct_type") return "concrete";
  if (type?.type === "interface_type") {
    return type.namedChildren.some((c) => c.type === "method_elem") ? "abstract" : null;
  }
  return null;
};

export const goTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass(readGoTypeAbstractness);
