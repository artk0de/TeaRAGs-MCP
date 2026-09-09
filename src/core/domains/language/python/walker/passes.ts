/**
 * Python's ordered extraction passes — EMPTY today (bd tea-rags-mcp-fmcly). The
 * E2 facets Python is expected to pull on (annotation type-source, decorator
 * expander, signatures, re-exports) arrive HERE, one `ExtractionFacetPass` each,
 * rather than growing `extractFromPythonFile`.
 */

import type { ExtractionFacetPass } from "../../kernel/extraction-passes.js";

export const PYTHON_EXTRACTION_PASSES: readonly ExtractionFacetPass[] = [];
