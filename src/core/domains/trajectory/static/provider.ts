import { extname, relative } from "node:path";

import type { PayloadBuilder } from "../../../contracts/types/provider.js";
import { detectTestFile } from "./test-detection.js";

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
    if (m.parentSymbolId) payload.parentSymbolId = m.parentSymbolId;
    if (m.parentType) payload.parentType = m.parentType;
    if (m.symbolId) payload.symbolId = m.symbolId;
    if (m.isDocumentation) payload.isDocumentation = m.isDocumentation;
    const relativePath = payload.relativePath as string;
    const language = m.language as string;
    if (detectTestFile(relativePath, language)) payload.isTest = true;
    const imports = m.imports as string[] | undefined;
    if (imports?.length) payload.imports = imports;
    const headingPath = m.headingPath as { depth: number; text: string }[] | undefined;
    if (headingPath?.length) payload.headingPath = headingPath;
    const navigation = m.navigation as { prevSymbolId?: string; nextSymbolId?: string } | undefined;
    if (navigation) payload.navigation = navigation;
    if (methodLines) {
      payload.methodLines = methodLines;
    }
    // Density: chars per line, dampened for small chunks relative to parent size.
    // Threshold adapts: sqrt(methodLines) for split chunks, sqrt(chunkLines) for standalone.
    const chunkLines = chunk.endLine - chunk.startLine;
    if (chunkLines > 0) {
      const threshold = Math.max(2, Math.ceil(Math.sqrt(methodLines ?? chunkLines)));
      const charsPerLine = chunk.content.length / chunkLines;
      const dampening = Math.min(1, chunkLines / threshold);
      payload.methodDensity = Math.round(charsPerLine * dampening);
    }
    return payload;
  }
}
