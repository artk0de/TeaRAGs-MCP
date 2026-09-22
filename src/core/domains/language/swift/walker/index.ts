/**
 * Swift walker barrel — the codegraph-extraction capability for the native
 * Swift provider. `extractFromSwiftFile` produces the per-file
 * `FileExtraction`; `swiftNameOf` maps an AST node to its `NamedSymbol`
 * descriptor.
 */

export { extractFromSwiftFile, normalizeSwiftReceiver, type SwiftExtractInput } from "./walker.js";
export { swiftNameOf } from "./name-of.js";
export { SWIFT_EXTRACTION_PASSES } from "./passes.js";
