/**
 * Python walker barrel — the codegraph-extraction capability for the native
 * Python provider. `extractFromPythonFile` produces the per-file
 * `FileExtraction`; `pyNameOf` maps an AST node to its `NamedSymbol` descriptor.
 * Both relocated from the chunker extraction dir + the codegraph provider per
 * the consolidation (spec §3; bd tea-rags-mcp-cen6).
 */

export { extractFromPythonFile, type PythonExtractInput } from "./walker.js";
export { pyNameOf } from "./name-of.js";
