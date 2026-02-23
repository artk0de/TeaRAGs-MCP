/**
 * MetadataExtractor - Thin facade delegating to focused utilities.
 */

import type { CodeChunk } from "../../types.js";
import { generateChunkId } from "./chunk-id.js";
import { calculateComplexity } from "./complexity.js";
import { extractImportsExports } from "./import-extractor.js";
import { detectLanguage } from "./language-detector.js";
import { containsSecrets } from "./secrets-detector.js";

export class MetadataExtractor {
  extractLanguage(filePath: string): string {
    return detectLanguage(filePath);
  }

  generateChunkId(chunk: CodeChunk): string {
    return generateChunkId(chunk);
  }

  calculateComplexity(code: string): number {
    return calculateComplexity(code);
  }

  containsSecrets(code: string): boolean {
    return containsSecrets(code);
  }

  extractImportsExports(code: string, language: string): { imports: string[]; exports: string[] } {
    return extractImportsExports(code, language);
  }
}
