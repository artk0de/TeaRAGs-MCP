/**
 * Rust walker barrel — the codegraph-extraction capability for the native Rust
 * provider. `extractFromRustFile` produces the per-file `FileExtraction`;
 * `rustNameOf` maps an AST node to its `NamedSymbol` descriptor. Both relocated
 * from the chunker extraction dir + the codegraph provider per the
 * consolidation (spec §3; bd tea-rags-mcp-cen6).
 */

export { extractFromRustFile, type RustExtractInput } from "./walker.js";
export { rustNameOf } from "./name-of.js";
