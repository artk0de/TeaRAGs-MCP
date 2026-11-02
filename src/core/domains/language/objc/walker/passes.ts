import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { OBJC_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";

export const OBJC_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  createIdentifierDeclarationFacetPass(OBJC_IDENTIFIER_DECLARATION_SYNTAX),
];
