/**
 * Bash's ordered extraction passes. The monolith `extractFromBashFile` runs
 * first (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after it.
 *
 *   1. identifier declarations (bd tea-rags-mcp-4p3sb.6) — the variables a
 *      function declares, untyped, for the naming lexicon. Until this facet the
 *      list was empty and the composer handed the monolith's result back by
 *      identity.
 *
 * A new Bash extraction facet is added HERE, one `ExtractionFacetPass` at a time,
 * rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { BASH_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";

export const BASH_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  createIdentifierDeclarationFacetPass(BASH_IDENTIFIER_DECLARATION_SYNTAX),
];
