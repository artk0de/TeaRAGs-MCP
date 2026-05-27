/**
 * JavaScript walker barrel — the codegraph-extraction capability for the native
 * JavaScript provider. `extractFromJavascriptFile` produces the per-file
 * `FileExtraction`; `jsNameOf` maps an AST node to its `NamedSymbol`
 * descriptor(s) (an array for the CommonJS alias-chain / HTTP-verb dispatch
 * shapes that emit multiple symbols from one node). Both relocated from the
 * chunker extraction dir + the codegraph provider per the consolidation
 * (spec §3; bd tea-rags-mcp-cen6).
 */

export { extractFromJavascriptFile, type JsExtractInput } from "./walker.js";
export { jsNameOf } from "./name-of.js";
