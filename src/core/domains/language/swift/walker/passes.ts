/**
 * Swift's ordered extraction passes. The monolith `extractFromSwiftFile` runs
 * first (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after it.
 *
 *   1. declared visibility (bd tea-rags-mcp-jwjyr.1) — `private` /
 *      `fileprivate` vs everything wider on `ChunkExtraction.visibility`, which
 *      the monolith never fills.
 *
 * A new Swift extraction facet is added HERE, one `ExtractionFacetPass` at a
 * time, rather than by growing the monolith. What a pass can and cannot express
 * — `mergeExtraction` is append-only, so a facet that must WIN over a channel
 * the monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";
import { swiftDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";

export const SWIFT_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [swiftDeclaredVisibilityFacetPass];
