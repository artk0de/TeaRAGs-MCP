/**
 * JavaScript type-abstractness census (bd tea-rags-mcp-r8hme.8). JavaScript
 * has no way to declare behaviour without implementing it, so every class
 * declaration is concrete and nothing is abstract. A class expression is a
 * value, not a declaration, and is not counted.
 */

import { typeAbstractnessFacetPass, type ExtractionFacetPass } from "../../../kernel/index.js";

export const javascriptTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass((node) =>
  node.type === "class_declaration" ? "concrete" : null,
);
