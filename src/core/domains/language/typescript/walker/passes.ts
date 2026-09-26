/**
 * TypeScript's ordered extraction passes. The monolith `extractFromTypescriptFile`
 * runs first (bd tea-rags-mcp-zhetx, E1 seam 0); each facet below folds in after
 * it.
 *
 *   1. declared visibility (bd tea-rags-mcp-jwjyr.1) — a class member's
 *      `private` / `protected` / `#name` access level on
 *      `ChunkExtraction.visibility`, which the monolith never fills.
 *   2. identifier declarations (bd tea-rags-mcp-4p3sb.4) — params, locals and
 *      class fields with their syntactic type, for the naming lexicon.
 *   3. symbol kind (bd tea-rags-mcp-vi0wx) — each named chunk's declaration
 *      kind on `ChunkExtraction.symbolKind`.
 *   4. type declarations (bd tea-rags-mcp-vi0wx, spec §1b) — one
 *      `FileExtraction.typeDeclarations` fact per module-level type, namespace
 *      and non-function `const`, for the naming lexicon.
 *
 * A new TypeScript extraction facet is added HERE, one `ExtractionFacetPass` at a
 * time, rather than by growing the monolith. What a pass can and cannot express —
 * `mergeExtraction` is append-only, so a facet that must WIN over a channel the
 * monolith already fills stays inside it — is documented once, in
 * `kernel/extraction-passes.ts`.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { tsNameOf } from "./name-of.js";
import { typescriptDeclaredVisibilityFacetPass } from "./passes/declared-visibility.js";
import { TYPESCRIPT_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";
import { ecmascriptSymbolKindFacetPass } from "./passes/symbol-kind.js";
import { typescriptTypeAbstractnessFacetPass } from "./passes/type-abstractness.js";
import { ecmascriptTypeDeclarationFacetPass } from "./passes/type-declarations.js";

export const TYPESCRIPT_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  typescriptDeclaredVisibilityFacetPass,
  typescriptTypeAbstractnessFacetPass,
  createIdentifierDeclarationFacetPass(TYPESCRIPT_IDENTIFIER_DECLARATION_SYNTAX),
  ecmascriptSymbolKindFacetPass(tsNameOf),
  ecmascriptTypeDeclarationFacetPass(tsNameOf),
];
