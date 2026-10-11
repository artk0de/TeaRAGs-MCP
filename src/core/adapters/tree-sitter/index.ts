/**
 * `adapters/tree-sitter` facade — the one import surface for code outside this
 * adapter. It is the anti-corruption layer from tree-sitter's native
 * `SyntaxNode` to the `AstNode` contract (`contracts/types/ast.ts`): the eager
 * materialization every chunker and the codegraph walk read, and the
 * native-tree gate that skips materializing a file no walker can use.
 */

export { fileIsInertForExtraction } from "./extraction-fast-path.js";
export { materializeTree } from "./materialize.js";
