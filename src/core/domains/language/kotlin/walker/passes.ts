import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { kotlinDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";
import { KOTLIN_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";
import { kotlinReceiverTypesFacetPass } from "./passes/receiver-types.js";

export const KOTLIN_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  kotlinDeclaredVisibilityFacetPass,
  createIdentifierDeclarationFacetPass(KOTLIN_IDENTIFIER_DECLARATION_SYNTAX),
  kotlinReceiverTypesFacetPass,
];
