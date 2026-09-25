/**
 * Bash node→chunk classifier (bd tea-rags-mcp-lyo4p).
 *
 * A top-level `command` is chunkable so a script body with no function wrapper
 * is still indexed, but its `name` field is the COMMAND it runs — the callee.
 * Under the generic shaping that became the chunk's symbolId, so every block
 * that called `note` claimed the id of `note()` itself (x10 in
 * tests/hooks/inject-rules.test.sh), and `find_symbol("note")` returned the
 * callers alongside the definition. A command declares nothing: it is a
 * `statement`, labelled by what it runs and owning no id. Only a
 * `function_definition` names a symbol, through the generic path.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkDecision, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";

export class BashChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: AstNode): ChunkDecision {
    return node.type === "command" ? { kind: "statement" } : { kind: "passthrough" };
  }
}
