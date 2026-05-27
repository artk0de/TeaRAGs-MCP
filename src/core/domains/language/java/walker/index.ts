/**
 * Java walker barrel — the codegraph-extraction capability for the native Java
 * provider. `extractFromJavaFile` produces the per-file `FileExtraction`;
 * `javaNameOf` maps an AST node to its `NamedSymbol` descriptor. Both relocated
 * from the chunker extraction dir + the codegraph provider per the
 * consolidation (spec §3; bd tea-rags-mcp-cen6).
 */

export { extractFromJavaFile, type JavaExtractInput } from "./walker.js";
export { javaNameOf } from "./name-of.js";
