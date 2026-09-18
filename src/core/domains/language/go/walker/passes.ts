/**
 * Go's ordered extraction passes. The monolith `extractFromGoFile` runs first
 * (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after it.
 *
 *   1. struct field types (bd tea-rags-mcp-e6xx) — every top-level struct's
 *      named and embedded fields on `classFieldTypesByClassKey`, the channel
 *      the resolver follows for method promotion and field chains.
 *
 * A new Go extraction facet is added HERE, one `ExtractionFacetPass` at a time,
 * rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";
import { goStructFieldTypesFacetPass } from "./passes/struct-field-types.js";

export const GO_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [goStructFieldTypesFacetPass];
