import { extname, relative } from "node:path";

import type { PayloadBuilder } from "../../contracts/types/provider.js";

export class StaticPayloadBuilder implements PayloadBuilder {
  buildPayload(
    chunk: { content: string; startLine: number; endLine: number; metadata: Record<string, unknown> },
    codebasePath: string,
  ): Record<string, unknown> {
    const m = chunk.metadata;
    const filePath = m.filePath as string;
    const methodLines = m.methodLines as number | undefined;
    const payload: Record<string, unknown> = {
      content: chunk.content,
      contentSize: chunk.content.length,
      relativePath: relative(codebasePath, filePath),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      fileExtension: extname(filePath),
      language: m.language,
      codebasePath,
      chunkIndex: m.chunkIndex,
    };
    if (m.name) payload.name = m.name;
    if (m.chunkType) payload.chunkType = m.chunkType;
    if (m.parentName) payload.parentName = m.parentName;
    if (m.parentType) payload.parentType = m.parentType;
    if (m.symbolId) payload.symbolId = m.symbolId;
    if (m.isDocumentation) payload.isDocumentation = m.isDocumentation;
    const imports = m.imports as string[] | undefined;
    if (imports?.length) payload.imports = imports;
    if (methodLines) {
      payload.methodLines = methodLines;
      payload.methodDensity = Math.round(chunk.content.length / methodLines);
    }
    return payload;
  }
}
