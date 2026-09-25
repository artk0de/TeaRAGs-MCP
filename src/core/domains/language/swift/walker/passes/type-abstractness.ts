/**
 * Swift type-abstractness census (bd tea-rags-mcp-r8hme.8): a protocol is
 * abstract; a class, struct, enum or actor is concrete; an extension re-opens a
 * type declared elsewhere and counts as neither. The kind is the walker's own
 * reading (`swiftTypeDeclarationKind`), the one `typeDeclarations` publishes.
 */

import { typeAbstractnessFacetPass, type ExtractionFacetPass } from "../../../kernel/index.js";
import { swiftTypeDeclarationKind } from "../walker.js";

export const swiftTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass((node) => {
  const kind = swiftTypeDeclarationKind(node);
  if (kind === null || kind === "extension") return null;
  return kind === "protocol" ? "abstract" : "concrete";
});
