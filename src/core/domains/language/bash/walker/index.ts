/**
 * Bash walker barrel — the codegraph-extraction capability for the native Bash
 * provider. `extractFromBashFile` produces the per-file `FileExtraction`;
 * `bashNameOf` maps an AST node to its `NamedSymbol` descriptor. Both relocated
 * from the chunker extraction dir + the codegraph provider per the
 * consolidation (spec §3; bd tea-rags-mcp-cen6).
 */

export { extractFromBashFile, type BashExtractInput } from "./walker.js";
export { bashNameOf } from "./name-of.js";
