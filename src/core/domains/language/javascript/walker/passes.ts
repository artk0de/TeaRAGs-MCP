/**
 * JavaScript's ordered extraction passes. The monolith
 * `extractFromJavascriptFile` runs first (bd tea-rags-mcp-zhetx, E1 seam 0);
 * each facet below folds in after it.
 *
 *   1. declared visibility (bd tea-rags-mcp-jwjyr.1) — a class member's `#name`
 *      private access on `ChunkExtraction.visibility`. The reader is
 *      TypeScript's, for the same reason `jsNameOf` delegates to `tsNameOf`: the
 *      class-member node shapes are shared, and JavaScript's grammar simply has
 *      no `accessibility_modifier` for it to find.
 *
 * A new JavaScript extraction facet is added HERE, one `ExtractionFacetPass` at a
 * time, rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import { declaredVisibilityFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { readEcmascriptDeclaredVisibility } from "../../typescript/walker/passes/declared-visibility.js";

export const JAVASCRIPT_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  declaredVisibilityFacetPass(readEcmascriptDeclaredVisibility),
];
