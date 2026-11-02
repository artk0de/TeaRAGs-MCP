/**
 * Rust node→chunk classifier.
 *
 * A test-only item at the top level of a file — `#[test] fn smoke`,
 * `#[cfg(test)] fn fixture`, a `#[cfg(test)] struct` — sits in no container, so
 * no container hook ever sees it when it has no member to extract, and the
 * generic shaping would label it production code. It is classified here into
 * the one chunk `rustInlineItemChunks` gives it — `test` for a test-family
 * function, `test_setup` for anything else — with the kernel's id. Every other
 * node takes the generic path; a test-only container with members is claimed
 * by `rustTestScopeChunkerHook` before this decision is read.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkDecision, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { isInlineTestNode } from "../inline-tests.js";
import { rustInlineItemChunks } from "./test-scope-chunker.js";

/** Only the id and type are read from the kernel here; the engine cuts the content. */
const ID_ONLY_CHUNKING_CONFIG = { maxChunkSize: Number.MAX_SAFE_INTEGER };

export class RustChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: AstNode, filePath?: string): ChunkDecision {
    if (filePath === undefined || !isInlineTestNode(node, node.text)) return { kind: "passthrough" };
    const itemSource = { text: node.text, startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
    const [chunk] = rustInlineItemChunks(node, itemSource, filePath, ID_ONLY_CHUNKING_CONFIG);
    if (chunk?.symbolId === undefined || chunk.name === undefined) return { kind: "passthrough" };
    return {
      kind: "emit",
      chunks: [
        { name: chunk.name, symbolId: chunk.symbolId, chunkType: chunk.chunkType === "test" ? "test" : "test_setup" },
      ],
    };
  }
}
