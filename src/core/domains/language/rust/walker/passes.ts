/**
 * Rust's ordered extraction passes. The monolith `extractFromRustFile` runs
 * first (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after it.
 *
 *   1. declared visibility (bd tea-rags-mcp-jwjyr.1) — `pub` vs module-private
 *      on `ChunkExtraction.visibility`, which the monolith never fills.
 *   2. identifier declarations (bd tea-rags-mcp-4p3sb.5) — params, `let`
 *      locals and struct fields with their syntactic type, for the naming
 *      lexicon.
 *
 * A new Rust extraction facet is added HERE, one `ExtractionFacetPass` at a time,
 * rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { rustDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";
import { RUST_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";
import { rustTypeAbstractnessFacetPass } from "./passes/type-abstractness.js";

export const RUST_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  rustDeclaredVisibilityFacetPass,
  rustTypeAbstractnessFacetPass,
  createIdentifierDeclarationFacetPass(RUST_IDENTIFIER_DECLARATION_SYNTAX),
];
