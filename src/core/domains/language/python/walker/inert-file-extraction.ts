/**
 * Python's `LanguageWalker.inertFileExtraction` — what the walk would publish
 * beyond the empty extraction for a file the extraction gate calls inert, read
 * off the NATIVE root so the file is never materialized.
 *
 * Two channels survive an inert file, each answered by the owner of the same
 * channel on the walk path:
 *   - `typeDeclarations` — module-scope constants and `type X = …` aliases,
 *     through {@link collectPythonModuleTypeDeclarations}, which shares the
 *     walk's per-statement visitor (bd tea-rags-mcp-vi0wx);
 *   - `typeAbstractness` — the census, always present and 0/0 here
 *     ({@link pythonInertFileTypeAbstractness}), because a census that ran and
 *     found no type is a measurement, not a NULL (bd tea-rags-mcp-r8hme.8).
 *
 * Every other channel the walk emits is rooted in an extraction-bearing node
 * type, so it stays absent. `scripts/spikes/py-inert-file-proof.ts` checks the
 * whole claim against the real walker on every inert file of five corpora.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { InertFileExtractionFacets } from "../../../../contracts/types/language.js";
import { pythonInertFileTypeAbstractness } from "./passes/type-abstractness.js";
import { collectPythonModuleTypeDeclarations } from "./type-declarations.js";

export function pythonInertFileExtraction(nativeRoot: AstNode): InertFileExtractionFacets {
  const typeDeclarations = collectPythonModuleTypeDeclarations(nativeRoot);
  return {
    ...(typeDeclarations.length > 0 ? { typeDeclarations } : {}),
    typeAbstractness: pythonInertFileTypeAbstractness(),
  };
}
