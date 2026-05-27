/**
 * Go walker barrel — the codegraph-extraction capability for the native Go
 * provider. `extractFromGoFile` produces the per-file `FileExtraction`;
 * `goNameOf` maps an AST node to its `NamedSymbol` descriptor. Both relocated
 * from the chunker extraction dir + the codegraph provider per the
 * consolidation (spec §3; bd tea-rags-mcp-cen6).
 */

export { extractFromGoFile, type GoExtractInput } from "./walker.js";
export { goNameOf } from "./name-of.js";
