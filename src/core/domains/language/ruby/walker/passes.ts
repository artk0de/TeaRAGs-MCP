/**
 * Ruby's ordered extraction passes — EMPTY, and that is the point of E1 seam 0
 * (bd tea-rags-mcp-fmcly). `extractFromRubyFile` stays the native monolith it is;
 * the composer runs it and, finding no passes, hands its output back untouched.
 *
 * A NEW Ruby extraction facet is added HERE, as one `ExtractionFacetPass`, never
 * by re-slicing the monolith. Precedence inversions the monolith already encodes
 * (YARD `@return` overwriting body inference in `type-channels.ts`) cannot be
 * expressed by a pass — `mergeExtraction` never lets a pass overwrite the native
 * walker — so a facet that needs to WIN over an existing channel belongs inside
 * the monolith, not here.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";

export const RUBY_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [];
