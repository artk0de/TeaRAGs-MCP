/**
 * Python's type-fact facet (E2 seam 2, bd tea-rags-mcp-9fgdi) — the whole seam
 * in one `ExtractionFacetPass`:
 * `sources → TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER) → pythonTypeChannels`.
 *
 * The native walker is untouched and runs first; `mergeExtraction` folds this in
 * append-only, so a coordinate the walker already wrote keeps the walker's
 * answer. That is the whole reason a new Python facet is a new pass rather than
 * an edit to `extractFromPythonFile`.
 */
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type { ExtractionFacetPass } from "../../../kernel/extraction-passes.js";
import { TypeFactStore } from "../../../kernel/type-fact-store.js";
import type { InlineTypeSource } from "../../../kernel/type-facts.js";
import { pythonLocalTypeTrackingEnabled } from "../walker.js";
import {
  PYTHON_ANNOTATION_SOURCE,
  pythonAnnotationTypeSource,
  type PythonTypeSourceInput,
} from "./python-annotation-type-source.js";
import { PYTHON_DOCSTRING_SOURCE, pythonDocstringTypeSource } from "./python-docstring-type-source.js";
import { pythonTypeChannels } from "./python-type-channels.js";

/**
 * Python's source precedence, highest first. `"ast"` is the walker's own
 * constructor inference, which still lives in the monolith — the rank is
 * declared here so the day it becomes a source there is nothing to decide.
 */
export const PYTHON_TYPE_SOURCE_ORDER: readonly string[] = [PYTHON_ANNOTATION_SOURCE, PYTHON_DOCSTRING_SOURCE, "ast"];

export const PYTHON_INLINE_TYPE_SOURCES: readonly InlineTypeSource<PythonTypeSourceInput>[] = [
  pythonAnnotationTypeSource,
  pythonDocstringTypeSource,
];

export const pythonAnnotationTypeFacetPass: ExtractionFacetPass = {
  run: (root, ctx): Partial<FileExtraction> => {
    // Read ONCE per file, exactly where the monolith reads it, and pass it down
    // so both sources stay pure functions of their input.
    const input: PythonTypeSourceInput = { root, trackLocalTypes: pythonLocalTypeTrackingEnabled() };
    const facts = PYTHON_INLINE_TYPE_SOURCES.flatMap((source) => source.extract(input));
    if (facts.length === 0) return {};
    return pythonTypeChannels(TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER), ctx.chunks);
  },
};
