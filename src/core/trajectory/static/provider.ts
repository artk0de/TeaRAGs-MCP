import { extname, relative } from "node:path";

import type { CodeChunk } from "../../types.js";

export class StaticPayloadBuilder {
  static buildPayload(chunk: CodeChunk, codebasePath: string): Record<string, unknown> {
    const relativePath = relative(codebasePath, chunk.metadata.filePath);
    return {
      content: chunk.content,
      contentSize: chunk.content.length,
      relativePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      fileExtension: extname(chunk.metadata.filePath),
      language: chunk.metadata.language,
      codebasePath,
      chunkIndex: chunk.metadata.chunkIndex,
      ...(chunk.metadata.name && { name: chunk.metadata.name }),
      ...(chunk.metadata.chunkType && { chunkType: chunk.metadata.chunkType }),
      ...(chunk.metadata.parentName && { parentName: chunk.metadata.parentName }),
      ...(chunk.metadata.parentType && { parentType: chunk.metadata.parentType }),
      ...(chunk.metadata.symbolId && { symbolId: chunk.metadata.symbolId }),
      ...(chunk.metadata.isDocumentation && { isDocumentation: chunk.metadata.isDocumentation }),
      ...(chunk.metadata.imports?.length && { imports: chunk.metadata.imports }),
      ...(chunk.metadata.methodLines && {
        methodLines: chunk.metadata.methodLines,
        methodDensity: Math.round(chunk.content.length / chunk.metadata.methodLines),
      }),
    };
  }
}
