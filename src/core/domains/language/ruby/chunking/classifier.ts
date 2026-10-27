/**
 * Ruby node→chunk classifier (bd tea-rags-mcp-k0602).
 *
 * A Rake task defined at the top level of a `.rake` file sits in no
 * `namespace`, so no container hook ever sees it and the generic shaping would
 * name it by its call text (`task :sync`). It is the same production entry
 * point a namespaced task is: one `function` chunk addressed by its Rake name,
 * read by the same `rakeTaskNameOf` the scope chunker uses. Every other node —
 * and every node of any other file — takes the generic path.
 */
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkDecision, LanguageChunkClassifier } from "../../../../contracts/types/chunker.js";
import { isRakeFile, RAKE_TASK_METHODS, rakeCallName } from "./rake-filter.js";
import { rakeDescriptionStart, rakeTaskNameOf } from "./rake-scope-chunker.js";

export class RubyChunkClassifier implements LanguageChunkClassifier {
  classifyNode(node: AstNode, filePath?: string): ChunkDecision {
    if (filePath === undefined || !isRakeFile(filePath)) return { kind: "passthrough" };
    const methodName = rakeCallName(node);
    if (methodName === null || !RAKE_TASK_METHODS.has(methodName)) return { kind: "passthrough" };
    const name = rakeTaskNameOf(node);
    if (name === undefined || name === "") return { kind: "passthrough" };
    const leadingNode = rakeDescriptionStart(node);
    return {
      kind: "emit",
      chunks: [{ name, symbolId: name, chunkType: "function" }],
      ...(leadingNode === undefined ? {} : { leadingNode }),
    };
  }
}
