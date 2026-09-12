/**
 * Bash's ordered extraction passes — EMPTY, which is what makes Bash a plugin
 * host without moving a byte of its output: `composeExtractionWalker` runs
 * `extractFromBashFile` and, finding no passes, hands that result back BY
 * IDENTITY (bd tea-rags-mcp-zhetx, E1 seam 0).
 *
 * A new Bash extraction facet is added HERE, one `ExtractionFacetPass` at a time,
 * rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";

export const BASH_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [];
