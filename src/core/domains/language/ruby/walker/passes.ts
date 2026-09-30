/**
 * Ruby's ordered extraction passes (E1 seam 0, bd tea-rags-mcp-fmcly).
 * `extractFromRubyFile` stays the native monolith it is; the composer runs it
 * and folds in the passes below, each publishing a channel the monolith leaves
 * empty — the type-abstractness census, the identifier declarations
 * (bd tea-rags-mcp-4p3sb.3) and the fields accessor macros declare
 * (bd tea-rags-mcp-0qaht).
 *
 * A NEW Ruby extraction facet is added HERE, as one `ExtractionFacetPass`, never
 * by re-slicing the monolith. Precedence inversions the monolith already encodes
 * (YARD `@return` overwriting body inference in `type-channels.ts`) cannot be
 * expressed by a pass — `mergeExtraction` never lets a pass overwrite the native
 * walker — so a facet that needs to WIN over an existing channel belongs inside
 * the monolith, not here.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { rubyAccessorFieldFacetPass } from "./passes/accessor-field-declarations.js";
import { RUBY_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";
import { rubyTypeAbstractnessFacetPass } from "./passes/type-abstractness.js";

export const RUBY_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  rubyTypeAbstractnessFacetPass,
  createIdentifierDeclarationFacetPass(RUBY_IDENTIFIER_DECLARATION_SYNTAX),
  rubyAccessorFieldFacetPass,
];
