/**
 * Re-export from the tree-sitter adapter so existing imports continue to
 * resolve. The implementation lives in `adapters/tree-sitter/materialize.ts` so
 * that both the `ingest` chunker and the `trajectory` codegraph provider can
 * import it without a domain-boundary violation (trajectory → ingest is
 * forbidden).
 */
export { materializeTree } from "../../../../adapters/tree-sitter/index.js";
