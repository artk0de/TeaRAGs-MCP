/**
 * PHP's extraction passes. `extractFromPhpFile` runs first; each facet folds
 * in after it.
 *
 *   1. declared visibility — `private` / `protected` / `public` on the chunk.
 *      A method with no keyword is public. Classes stay unrecorded.
 *   2. identifier declarations — parameters, properties and locals, plus a
 *      method or function's declared return type.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { phpDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";
import { PHP_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";

export const PHP_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  phpDeclaredVisibilityFacetPass,
  createIdentifierDeclarationFacetPass(PHP_IDENTIFIER_DECLARATION_SYNTAX),
];
