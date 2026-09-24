/**
 * Swift's ordered extraction passes. The monolith `extractFromSwiftFile` runs
 * first (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after it.
 *
 *   1. declared visibility (bd tea-rags-mcp-jwjyr.1) — `private` /
 *      `fileprivate` vs everything wider on `ChunkExtraction.visibility`, which
 *      the monolith never fills.
 *   2. module-level values (bd tea-rags-mcp-y99pg.30) — a file-scope `let` /
 *      `var` under the module-scope key of the two run-global field channels,
 *      which the monolith fills only for types.
 *   3. identifier declarations (bd tea-rags-mcp-4p3sb.6) — params, locals and
 *      stored properties with their syntactic type, for the naming lexicon.
 *
 * A new Swift extraction facet is added HERE, one `ExtractionFacetPass` at a
 * time, rather than by growing the monolith. What a pass can and cannot express
 * — `mergeExtraction` is append-only, so a facet that must WIN over a channel
 * the monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { swiftDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";
import { SWIFT_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";
import { swiftModuleValuesFacetPass } from "./passes/module-values.js";
import { swiftTypeAbstractnessFacetPass } from "./passes/type-abstractness.js";

export const SWIFT_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  swiftDeclaredVisibilityFacetPass,
  swiftModuleValuesFacetPass,
  swiftTypeAbstractnessFacetPass,
  createIdentifierDeclarationFacetPass(SWIFT_IDENTIFIER_DECLARATION_SYNTAX),
];
