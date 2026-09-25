/**
 * TypeScript's ordered extraction passes. The monolith `extractFromTypescriptFile`
 * runs first (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after
 * it.
 *
 *   1. declared visibility (bd tea-rags-mcp-jwjyr.1) — a class member's
 *      `private` / `protected` / `#name` access level on
 *      `ChunkExtraction.visibility`, which the monolith never fills.
 *
 * A new TypeScript extraction facet is added HERE, one `ExtractionFacetPass` at a
 * time, rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import type { ExtractionFacetPass } from "../../kernel/index.js";
import { typescriptDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";
import { typescriptTypeAbstractnessFacetPass } from "./passes/type-abstractness.js";

export const TYPESCRIPT_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  typescriptDeclaredVisibilityFacetPass,
  typescriptTypeAbstractnessFacetPass,
];
