/**
 * Python's ordered extraction passes. The type-fact facet (bd
 * tea-rags-mcp-9fgdi) is the first entry; the other E2 facets Python is
 * expected to pull on (decorator expander, method signatures, re-exports)
 * arrive HERE, one `ExtractionFacetPass` each, rather than growing
 * `extractFromPythonFile`.
 */

import { createIdentifierDeclarationFacetPass, type ExtractionFacetPass } from "../../kernel/index.js";
import { pythonAnnotationTypeFacetPass } from "./passes/annotation-type-facts.js";
import { PYTHON_IDENTIFIER_DECLARATION_SYNTAX } from "./passes/identifier-declarations.js";
import { pythonParamArgTypesFacetPass } from "./passes/python-param-arg-types.js";
import { pythonTypeAbstractnessFacetPass } from "./passes/type-abstractness.js";

export const PYTHON_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [
  pythonAnnotationTypeFacetPass,
  pythonTypeAbstractnessFacetPass,
  createIdentifierDeclarationFacetPass(PYTHON_IDENTIFIER_DECLARATION_SYNTAX),
  pythonParamArgTypesFacetPass,
];
